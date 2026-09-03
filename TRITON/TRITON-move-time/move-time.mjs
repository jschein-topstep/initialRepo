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
 *   ]
 * }
 * ---------------------------------------------------------------------
 ******************************************************/

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

  const results = [];
  for (const movement of movements) {
    try {
      const outcome = await processMovement(movement, authObj, callSharedUtil);
      results.push({ teId: movement.teId, status: outcome.type, ...outcome });
    } catch (err) {
      results.push({ teId: movement.teId, status: "error", message: err.message });
    }
  }

  return jsonResponse(200, { results });
};

/*******************************************************
 * Core per-line movement logic, ported from move_time.js's main() loop
 * (the part that actually moves time -- CSV parsing, error emailing, and
 * attachment/workspace handling are all intentionally left out).
 ******************************************************/
async function processMovement(movement, authObj, callSharedUtil) {
  const { teId, tsId, userId, date, notes, projTarget, taskTarget } = movement;

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

    // Same story for `targetProjRec.customerid`.
    const targetProject = await fetchOne(callSharedUtil, authObj, "Project", { id: projTargetNum });
    if (!targetProject) throw new Error(`target project ${projTargetNum} not found`);

    /*
    const updatedOriginal = await callSharedUtil("tslib-putRecords", {
      authObj,
      recordType: "Task",
      writeObj: {
        id: teId,
        decimal_hours: timeDiff,
      },
    });
    */

    /*
    const createdEntry = await callSharedUtil("tslib-putRecords", {
      authObj,
      recordType: "Task",
      writeObj: {
        projectid: projTargetNum,
        projecttaskid: taskTargetNum,
        decimal_hours: timeToMove,
        userid: userId,
        date,
        customerid: targetProject.customerid,
        notes: notes || "",
        timesheetid: tsId,
        timetypeid: originalEntry.timetypeid,
      },
    });
    */

    return {
      type: "partial",
      updatedId: updatedOriginal?.id ?? teId,
      createdId: createdEntry?.id ?? null,
    };
  }

  // --- Full move: the whole entry just moves onto the new project/task in place --
  //     mirrors move_time.js's fullMove branch (no new record, no customerid change).
  /*
  const updated = await callSharedUtil("tslib-putRecords", {
    authObj,
    recordType: "Task",
    writeObj: {
      id: teId,
      projectid: projTargetNum,
      projecttaskid: taskTargetNum,
    },
  });
  */

  return { type: "full", updatedId: updated?.id ?? teId };
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