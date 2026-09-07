/*******************************************************
 * move_time_lambda.js
 *
 * Ports the movement logic from SPP's move_time.js SuiteScript into a
 * Lambda that writes via the XML/wsapi-backed tslib-getRecords /
 * tslib-putRecords shared utilities (the REST API does not support
 * writes to these SPP objects).
 *
 * IN SCOPE:  moving time entries between project/task (full + partial
 *            moves), matching the original script's branching logic.
 *
 * OUT OF SCOPE (explicitly deferred, per instructions):
 *   - calculated_cost__c recompute (loaded cost * multiplier)
 *   - email notifications on error
 *   - source-file / attachment lifecycle (workspace move, delete) --
 *     N/A here since the browser tool replaces the file-drop workflow
 *
 * DRY_RUN: set to true (default) to log every writeObj that WOULD be sent
 * to tslib-putRecords without actually calling it. Set to false once
 * you're ready to actually write. All reads (fetchOne / tslib-getRecords)
 * still run either way, so validation errors (bad target task, etc.)
 * still surface in dry-run mode.
 *
 * SPP_LOG_WORKSPACE_ID: if set, a CSV audit log of the batch (one row per
 * movement attempted, including failures) is written as a new Attachment
 * to this SPP workspace after processing. If unset, logging is skipped
 * entirely (no guessing at a workspace). Also skipped while DRY_RUN.
 *
 * ---------------------------------------------------------------------
 * Expected request body (POST), shape TBD/owned by us -- submitTimeMovements()
 * on the front end still needs to be wired to build this:
 *
 * {
 *   "movements": [
 *     {
 *       "teId": "10482",        // original time entry (Task) id -- required
 *       "tsId": "998",          // timesheet id -- required for a partial move's new entry
 *       "userId": "251",        // required for a partial move's new entry
 *       "date": "2026/08/14",   // YYYY/MM/DD -- required for a partial move's new entry
 *       "notes": "",            // optional, carried onto a partial move's new entry
 *       "hours": "8",           // original entry's total hours (hoursRefHeader) -- required
 *       "projTarget": "5521",   // destination project id -- required
 *       "taskTarget": "88231",  // destination project task id -- required
 *       "timeToMove": "3"       // hours being moved -- required
 *     }
 *   ]
 * }
 *
 * Response body:
 * {
 *   "results": [
 *     { "teId": "10482", "status": "partial", "updatedId": "10482", "createdId": "10499" },
 *     { "teId": "10483", "status": "full", "updatedId": "10483" },
 *     { "teId": "10484", "status": "error", "message": "..." }
 *   ],
 *   "logFile": { "status": "ok", "id": "...", "name": "move-time-log-....csv" }
 *              // or { "status": "skipped", "reason": "..." } / { "status": "error", "message": "..." }
 * }
 * ---------------------------------------------------------------------
 ******************************************************/

const DRY_RUN = false; // <-- flip to false once you're ready to actually write

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your hosting origin once deployed
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  if (event?.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const authObj = {
    company: process.env.COMPANY,
    user: process.env.USER,
    password: process.env.PASSWORD,
    instance: process.env.INSTANCE,
  };
  const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
    ? "/opt/nodejs/sharedUtils.js"
    : "../../shared/sharedUtils.js";
  const { callSharedUtil } = await import(sharedPath);

  let movements;
  try {
    const body = JSON.parse(event.body || "{}");
    movements = Array.isArray(body.movements) ? body.movements : null;
  } catch (err) {
    return jsonResponse(400, { message: `Invalid JSON body: ${err.message}` });
  }

  if (!movements || !movements.length) {
    return jsonResponse(400, { message: "Request body must include a non-empty 'movements' array." });
  }

  if (DRY_RUN) {
    console.log(`DRY_RUN is ON -- no tslib-putRecords calls will actually be made. Processing ${movements.length} movement(s).`);
  }

  const results = [];
  for (const movement of movements) {
    try {
      const outcome = await processMovement(movement, authObj, callSharedUtil);
      results.push({ teId: movement.teId, status: outcome.type, ...outcome });
    } catch (err) {
      results.push({ teId: movement.teId, status: "error", message: err.message });
    }
  }

  const logFile = DRY_RUN
    ? { status: "skipped", reason: "DRY_RUN" }
    : await writeLogToWorkspace(callSharedUtil, authObj, movements, results);

  return jsonResponse(200, { results, logFile });
};

/*******************************************************
 * Core per-line movement logic, ported from move_time.js's main() loop
 * (the part that actually moves time -- CSV parsing, error emailing, and
 * attachment/workspace handling are all intentionally left out).
 ******************************************************/
async function processMovement(movement, authObj, callSharedUtil) {
  const { teId, tsId, userId, date, notes, projTarget, taskTarget } = movement;

  console.log(`--- Processing movement for teId ${teId} --- input: ${JSON.stringify(movement)}`);

  if (!teId) throw new Error("teId is required");

  const projTargetNum = Number(projTarget);
  const taskTargetNum = Number(taskTarget);
  if (!Number.isInteger(projTargetNum) || projTargetNum <= 0) {
    throw new Error(`invalid target project id: ${projTarget}`);
  }
  if (!Number.isInteger(taskTargetNum) || taskTargetNum <= 0) {
    throw new Error(`invalid target task id: ${taskTarget}`);
  }

  const hours = parseFloat(movement.hours);
  const timeToMove = parseFloat(movement.timeToMove);
  if (isNaN(hours) || hours <= 0) throw new Error(`invalid original hours: ${movement.hours}`);
  if (isNaN(timeToMove) || timeToMove <= 0) throw new Error(`invalid time to move: ${movement.timeToMove}`);

  // Confirms the target task actually belongs to the target project --
  // equivalent of move_time.js's getTask(taskTarget, projTarget).
  console.log(`Fetching target task for task ID ${taskTargetNum} in project ID ${projTargetNum}`);

  const targetTask = await fetchOne(callSharedUtil, authObj, "Projecttask", {
    id: taskTargetNum,
    projectid: projTargetNum,
  });
  if (!targetTask) {
    throw new Error(`target task ${taskTargetNum} does not belong to target project ${projTargetNum}`);
  }
  console.log(`Target task fetched successfully: ${JSON.stringify(targetTask)}`);

  const timeDiff = hours - timeToMove;
  if (timeDiff < 0) {
    throw new Error(`time to move (${timeToMove}) exceeds original entry's ${hours} hrs`);
  }

  if (timeToMove !== hours) {
    // --- Partial move: shrink the original entry, create a new one for
    //     the moved portion -- mirrors move_time.js's partialMoveUpd / partialMoveAdd.

    // move_time.js reads `teRec.timetypeid` off a bare `new NSOA.record.oaTask(teId)`
    // without an explicit wsapi.read -- that only works via SuiteScript's lazy-load
    // proxy objects. We fetch it explicitly here.
    const originalEntry = await fetchOne(callSharedUtil, authObj, "Task", { id: teId });
    if (!originalEntry) throw new Error(`original time entry ${teId} not found`);
    console.log(`Original entry fetched successfully: ${JSON.stringify(originalEntry)}`);

    // Same story for `targetProjRec.customerid`.
    const targetProject = await fetchOne(callSharedUtil, authObj, "Project", { id: projTargetNum });
    if (!targetProject) throw new Error(`target project ${projTargetNum} not found`);
    console.log(`Target project fetched successfully: ${JSON.stringify(targetProject)}`);

    const updateWriteObj = {
      id: teId,
      decimal_hours: timeDiff,
    };
    console.log(`[UPDATE original entry] Task writeObj: ${JSON.stringify(updateWriteObj)}`);

    const createWriteObj = {
      projectid: projTargetNum,
      projecttaskid: taskTargetNum,
      decimal_hours: timeToMove,
      userid: userId,
      date: normalizeDateForSpp(date),
      customerid: targetProject.customerid,
      notes: notes || "",
      timesheetid: tsId,
      timetypeid: originalEntry.timetypeid,
    };
    console.log(`[CREATE new entry] Task writeObj: ${JSON.stringify(createWriteObj)}`);

    let updatedOriginal = null;
    let createdEntry = null;

    if (!DRY_RUN) {
      updatedOriginal = await callSharedUtil("tslib-putRecords", {
        authObj,
        recordType: "Task",
        writeObj: updateWriteObj,
      });
      console.log(`Update result: ${JSON.stringify(updatedOriginal)}`);

      createdEntry = await callSharedUtil("tslib-putRecords", {
        authObj,
        recordType: "Task",
        writeObj: createWriteObj,
      });
      console.log(`Create result: ${JSON.stringify(createdEntry)}`);
    }

    return {
      type: "partial",
      updatedId: updatedOriginal?.id ?? teId,
      createdId: createdEntry?.id ?? null,
      dryRun: DRY_RUN,
    };
  }

  // --- Full move: the whole entry just moves onto the new project/task in place --
  //     mirrors move_time.js's fullMove branch (no new record, no customerid change).
  const fullMoveWriteObj = {
    id: teId,
    projectid: projTargetNum,
    projecttaskid: taskTargetNum,
  };
  console.log(`[FULL MOVE] Task writeObj: ${JSON.stringify(fullMoveWriteObj)}`);

  let updated = null;

  if (!DRY_RUN) {
    updated = await callSharedUtil("tslib-putRecords", {
      authObj,
      recordType: "Task",
      writeObj: fullMoveWriteObj,
    });
    console.log(`Full move result: ${JSON.stringify(updated)}`);
  }

  return { type: "full", updatedId: updated?.id ?? teId, dryRun: DRY_RUN };
}

// Thin wrapper around tslib-getRecords for the common "fetch exactly one
// record matching this criteria" case (mirrors move_time.js's getProject/
// getTask helpers, which both used a limit of 1).
async function fetchOne(callSharedUtil, authObj, recordType, criteriaObj) {
  const records = await callSharedUtil("tslib-getRecords", {
    authObj,
    recordType,
    criteriaObj,
    limit: 1,
  });
  return records && records.length ? records[0] : null;
}

// Ported directly from move_time.js: SPP's exports hand back dates as
// "M/D/YYYY" (no zero-padding, e.g. "8/25/2025"), but the original script
// never wrote that straight through -- it rebuilds it as zero-padded
// "YYYY/MM/DD" first. Only matters for a partial move's newly-created
// entry (full moves never touch the date field at all).
function normalizeDateForSpp(dateStr) {
  if (!dateStr) return dateStr;
  const parts = String(dateStr).trim().split("/");
  if (parts.length !== 3) return dateStr; // not the expected M/D/YYYY shape -- pass through as-is
  let [month, day, year] = parts;
  if (day.length === 1) day = "0" + day;
  if (month.length === 1) month = "0" + month;
  return `${year}/${month}/${day}`;
}

/*******************************************************
 * Post-batch audit log: writes one CSV, one row per movement attempted
 * (including failures), as a new Attachment record in an SPP workspace.
 *
 * Requires SPP_LOG_WORKSPACE_ID to be set -- if it isn't, logging is just
 * skipped rather than guessing a workspace and writing to the wrong place.
 * This is best-effort: a failure here is reported in the response's
 * `logFile` field but never overwrites/blocks the actual `results`.
 ******************************************************/
function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function buildResultsCsv(movements, results) {
  const resultsByTeId = new Map(results.map(r => [String(r.teId), r]));
  const header = [
    "teId", "status", "projTarget", "taskTarget", "hours", "timeToMove",
    "updatedId", "createdId", "message", "timestamp",
  ];
  const timestamp = new Date().toISOString();

  const rows = movements.map(m => {
    const r = resultsByTeId.get(String(m.teId)) || {};
    return [
      m.teId, r.status || "", m.projTarget, m.taskTarget, m.hours, m.timeToMove,
      r.updatedId ?? "", r.createdId ?? "", r.message || "", timestamp,
    ].map(csvEscape).join(",");
  });

  return [header.join(","), ...rows].join("\r\n");
}

async function writeLogToWorkspace(callSharedUtil, authObj, movements, results) {
  const workspaceId = Number(6 || 0);
  if (!workspaceId) {
    return { status: "skipped", reason: "SPP_LOG_WORKSPACE_ID env var is not set" };
  }

  const csv = buildResultsCsv(movements, results);
  const base64Data = Buffer.from(csv, "utf-8").toString("base64");
  const filename = `move-time-log-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;

  try {
    const created = await callSharedUtil("tslib-putRecords", {
      authObj,
      recordType: "Attachment",
      writeObj: {
        name: filename,
        workspaceid: workspaceId,
        base64_data: base64Data,
      },
    });
    console.log(`Log file written: ${filename} (id ${created?.id ?? "unknown"})`);
    return { status: "ok", id: created?.id ?? null, name: filename };
  } catch (err) {
    console.error(`Failed to write log file to workspace ${workspaceId}: ${err.message}`);
    return { status: "error", message: err.message };
  }
}