export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  console.log(`bodyJSON: ${JSON.stringify(bodyJSON)}`);
  const projId = bodyJSON.projId;

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

  async function calculateUnitPricePer(projId) {
    const sppTaskRequest = {
      authObj: authObj,
      recordType: "Projecttask",
      criteriaObj: {
        projectid: projId,
      },
      limit: 1000,
    };
    const taskRecords = await callSharedUtil(
      "tslib-getRecords",
      sppTaskRequest,
    );

    for (const taskRecord of taskRecords) {
      if (taskRecord.is_a_phase != 1) {
        const sppAssignmentRequest = {
          authObj: authObj,
          recordType: "Projecttaskassign",
          criteriaObj: {
            projecttaskid: taskRecord.id,
          },
          limit: 1000,
        };
        const assignmentRecords = await callSharedUtil(
          "tslib-getRecords",
          sppAssignmentRequest,
        );

        let assignmentBidTotal = 0;
        let assignmentCostTotal = 0;

        if (assignmentRecords?.length > 0) {
          for (const assignmentRecord of assignmentRecords) {
            assignmentBidTotal += parseFloat(assignmentRecord.assign_bid__c);
            assignmentCostTotal += parseFloat(assignmentRecord.assign_cost__c);
          }
        } else {
          assignmentBidTotal = taskRecord.unit_total_bid__c;
          assignmentCostTotal = taskRecord.unit_total_cost__c;
        }

        const unitPrice =
          taskRecord.number_units__c !== 0
            ? assignmentBidTotal / taskRecord.number_units__c
            : 0;
        const taskUpdateDetails = {
          authObj: authObj,
          recordType: "Projecttask",
          writeObj: {
            id: taskRecord.id,
            unit_total_bid__c: assignmentBidTotal,
            unit_price_per__c: unitPrice,
            unit_total_cost__c: assignmentCostTotal,
          },
        };

        const taskUpdate = await callSharedUtil(
          "tslib-putRecords",
          taskUpdateDetails,
        );

        const billingRuleDetails = {
          authObj: authObj,
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
        };

        const billingRuleUpdate = await callSharedUtil(
          "tslib-putRecords",
          billingRuleDetails,
        );

        const uprateDetails = {
          authObj: authObj,
          recordType: "Uprate",
          writeObj: {
            categoryid: taskRecord.default_category,
            userid: 251,
            rate: unitPrice,
            project_billing_ruleid: billingRuleUpdate.id,
          },
        };

        const uprateAdd = await callSharedUtil(
          "tslib-putRecords",
          uprateDetails,
        );
      }
    }
  }
};
