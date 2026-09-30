const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);

const authObj = {
  company: process.env.COMPANY,
  user: process.env.USER,
  password: process.env.PASSWORD,
  instance: process.env.INSTANCE,
};

// ---------------------------------------------------------------------------
// XML escaping (same as the bid grid import script). Task names like
// "R&D Setup" end up in the billing rule name, so writes need escaping too.
// Remove if xmlEscape is ever added inside sharedUtils (avoids double-escape).
// ---------------------------------------------------------------------------
const XML_ESCAPED_REQUEST_KEYS = ["criteriaObj", "writeObj"];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;") // must be first
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeDeep(value) {
  if (typeof value === "string") return xmlEscape(value);
  if (Array.isArray(value)) return value.map(escapeDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, escapeDeep(v)]),
    );
  }
  return value;
}

async function callSpp(utilName, request) {
  const safeRequest = { ...request };
  for (const key of XML_ESCAPED_REQUEST_KEYS) {
    if (safeRequest[key] !== undefined) {
      safeRequest[key] = escapeDeep(safeRequest[key]);
    }
  }
  return callSharedUtil(utilName, safeRequest);
}

// SPP returns numbers as strings ("1,234.50", "", "0"); normalize to a number.
function toNumber(value) {
  const n = parseFloat(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------

export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  console.log(`bodyJSON: ${JSON.stringify(bodyJSON)}`);
  const projId = bodyJSON.projId;

  if (!projId) {
    throw new Error("projId is required");
  }

  // FIX: the original handler defined calculateUnitPricePer but never called
  // it, so the Lambda returned immediately without writing anything.
  const summary = await calculateUnitPricePer(projId);
  console.log(`summary: ${JSON.stringify(summary)}`);
  return summary;
};

async function calculateUnitPricePer(projId) {
  const summary = {
    projId,
    tasksUpdated: 0,
    billingRulesCreated: 0,
    upratesCreated: 0,
    upratesUpdated: 0,
    errors: [],
  };

  const taskRecords =
    (await callSpp("tslib-getRecords", {
      authObj,
      recordType: "Projecttask",
      criteriaObj: { projectid: projId },
      limit: 1000,
    })) ?? [];

  for (const taskRecord of taskRecords) {
    if (taskRecord.is_a_phase == 1) continue;

    try {
      const assignmentRecords = await callSpp("tslib-getRecords", {
        authObj,
        recordType: "Projecttaskassign",
        criteriaObj: { projecttaskid: taskRecord.id },
        limit: 1000,
      });

      let bidTotal = 0;
      let costTotal = 0;

      if (assignmentRecords?.length > 0) {
        for (const assignment of assignmentRecords) {
          bidTotal += toNumber(assignment.assign_bid__c);
          costTotal += toNumber(assignment.assign_cost__c);
        }
      } else {
        bidTotal = toNumber(taskRecord.unit_total_bid__c);
        costTotal = toNumber(taskRecord.unit_total_cost__c);
      }

      // Price per Unit = Unit Total Bid / # of Units
      const units = toNumber(taskRecord.number_units__c);
      const unitPrice = units !== 0 ? bidTotal / units : 0;

      await callSpp("tslib-putRecords", {
        authObj,
        recordType: "Projecttask",
        writeObj: {
          id: taskRecord.id,
          unit_total_bid__c: bidTotal,
          unit_price_per__c: unitPrice,
          unit_total_cost__c: costTotal,
        },
      });
      summary.tasksUpdated++;

      await upsertBillingRate(projId, taskRecord, unitPrice, summary);
    } catch (err) {
      console.error(`Task ${taskRecord.id} failed: ${err.message}`);
      summary.errors.push({ taskId: taskRecord.id, message: err.message });
    }
  }

  return summary;
}

// Creates the task's billing rule + uprate on the first run and updates the
// uprate's rate on later runs, so re-running on a bid grid update doesn't
// pile up duplicate billing rules.
async function upsertBillingRate(projId, taskRecord, unitPrice, summary) {
  const existingRules = await callSpp("tslib-getRecords", {
    authObj,
    recordType: "Projectbillingrule",
    criteriaObj: {
      projectid: projId,
      project_task_filter: taskRecord.id,
    },
    limit: 1,
  });

  let ruleId = existingRules?.[0]?.id;

  if (!ruleId) {
    const billingRuleResponse = await callSpp("tslib-putRecords", {
      authObj,
      recordType: "Projectbillingrule",
      writeObj: {
        active: 1,
        type: "T",
        categoryid: taskRecord.default_category,
        name: `Billing rule for ${taskRecord.name}`,
        project_task_filter: taskRecord.id,
        projectid: projId,
        rate_from: "U",
      },
    });
    ruleId = billingRuleResponse?.id;
    if (!ruleId) {
      throw new Error(
        `Billing rule create returned no id: ${JSON.stringify(billingRuleResponse)}`,
      );
    }
    summary.billingRulesCreated++;
  }

  const existingUprates = await callSpp("tslib-getRecords", {
    authObj,
    recordType: "Uprate",
    criteriaObj: {
      project_billing_ruleid: ruleId,
      categoryid: taskRecord.default_category,
    },
    limit: 1,
  });
  const existingUprateId = existingUprates?.[0]?.id;

  await callSpp("tslib-putRecords", {
    authObj,
    recordType: "Uprate",
    writeObj: {
      categoryid: taskRecord.default_category,
      userid: 251,
      rate: unitPrice,
      project_billing_ruleid: ruleId,
      ...(existingUprateId && { id: existingUprateId }),
    },
  });

  if (existingUprateId) summary.upratesUpdated++;
  else summary.upratesCreated++;
}

async function test() {
  const result = await handler({ body: JSON.stringify({ projId: 0 }) });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
