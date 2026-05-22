import { parse } from "csv-parse/sync";

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
5;

async function deleteExistingTasks(projId) {
  const sppTaskRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    criteriaObj: {
      projectid: projId,
    },
    limit: 1000,
    fields: "id",
  };

  const taskRecords = await callSharedUtil("tslib-getRecords", sppTaskRequest);

  const sppDeleteRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    recordsToDelete: taskRecords,
  };

  const deletedRecords = await callSharedUtil(
    "tslib-deleteRecords",
    sppDeleteRequest,
  );

  // finish this
  return;
}

export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  const fileId = bodyJSON.fileId;

  const sppAttachmentRequest = {
    authObj: authObj,
    recordType: "Attachment",
    criteriaObj: {
      id: fileId,
    },
    limit: 1,
  };
  const attachmentRecord = await callSharedUtil(
    "tslib-getRecords",
    sppAttachmentRequest,
  );

  const base64 = atob(attachmentRecord.base64_data);
  const fileLines = parse(base64, {
    columns: true,
    skip_empty_lines: true,
  });

  const phaseNames = [];
  console.log(`headers: ${JSON.stringify(fileLines[0])}`);

  const projectName = fileLines[0]["Project ID"];
  const sppProjectRequest = {
    authObj: authObj,
    recordType: "Project",
    criteriaObj: {
      name: projectName,
    },
    limit: 1,
  };
  const projectRecord = await callSharedUtil(
    "tslib-getRecords",
    sppProjectRequest,
  );
  console.log(`Project ID: ${projectRecord.id}`);

  //const deleteResponse = await deleteExistingTasks(projectRecord.id);

  const inflationPlusDiscount =
    parseFloat(projectRecord.proj_inflation__c) +
    parseFloat(projectRecord.proj_discount__c);

  const projectCalculations = {
    id: projectRecord.id,
    proj_directs__c: 0,
    proj_total_direct__c: inflationPlusDiscount,
    proj_pt__c: 0,
    proj_pt_fees__c: 0,
    proj_pt_total__c: 0,
    proj_ig__c: 0,
    proj_contract_value__c: inflationPlusDiscount,
    proj_direct_cost__c: 0,
    proj_pt_cost__c: 0,
    proj_ig_cost__c: 0,
    proj_total_cost__c: 0,
    proj_direct_gm__c: 0,
    proj_direct_gm_percent__c: 0,
    proj_project_gm__c: inflationPlusDiscount,
    proj_project_gm_percent__c: 0,
    proj_total_hours__c: 0,
  };

  const phaseObjArray = [];
  const taskObjArray = [];
  const assignmentObjArray = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i]["Header"]?.length > 0) {
      let matchingPhaseObject = phaseObjArray.find(
        (phase) => phase.name === fileLines[i]["Header"],
      );

      if (matchingPhaseObject === undefined) {
        // the phase has not been encountered yet
        const phaseExtId = `proj${projectRecord.id}_phase${phaseObjArray.length}`;
        const newPhaseObj = {
          projectid: projectRecord.id,
          name: fileLines[i]["Header"],
          is_a_phase: 1,
          externalid: phaseExtId,
        };

        phaseObjArray.push(newPhaseObj);
        matchingPhaseObject = newPhaseObj;
      }

      let matchingTaskObject = taskObjArray.find(
        (task) => task.name === fileLines[i]["Unit Name"],
      );

      if (matchingTaskObject === undefined) {
        // the task has not been encountered yet
        const taskExtId = `proj${projectRecord.id}_task${taskObjArray.length}`;
        const newTaskObj = {
          projectid: projectRecord.id,
          name: fileLines[i]["Unit Name"],
          is_a_phase: "",
          parentid: {
            value: matchingPhaseObject.externalid,
            lookupBy: "externalid",
            inTable: "Projecttask",
          },
          unit_budget_cat__c: fileLines[i]["Budget Category"],
          service: {
            value: fileLines[i]["Revenue Account"],
            lookupBy: "name",
            inTable: "Category",
          },
          id_number: fileLines[i]["Unit Number"],
          unit_basis__c: fileLines[i]["Unit Basis"],
          number_units__c: fileLines[i]["# of Units"],
          externalid: taskExtId,
        };

        taskObjArray.push(newTaskObj);
        matchingTaskObject = newTaskObj;
      }

      const newAssignmentObj = {
        projectid: projectRecord.id,
        projecttaskid: {
          value: matchingTaskObject.externalid,
          lookupBy: "externalid",
          inTable: "Projecttask",
        },
        costCenter: {
          value: fileLines[i]["Team"],
          lookupBy: "name",
          inTable: "Costcenter",
        },
        assign_functional_area__c: {
          value: fileLines[i]["Functional Area"],
          lookupBy: "name",
          inTable: "Department",
        },
        userid: {
          value: fileLines[i]["Bid Role"],
          lookupBy: "name",
          inTable: "User",
        },
        planned_hours: fileLines[i]["total hours"],
        assign_cost__c: fileLines[i]["Total Cost"],
        assign_bid__c: fileLines[i]["Total Bid"],
      };

      assignmentObjArray.push(newAssignmentObj);

      accumulateProjectTotals(fileLines[i], projectCalculations);
    }
  }

  // create phases
  const phaseWriteRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    writeObj: phaseObjArray,
  };

  const phaseWriteResponse = await callSharedUtil(
    "tslib-putRecords",
    phaseWriteRequest,
  );

  // create tasks
  const taskWriteRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    writeObj: taskObjArray,
  };

  const taskWriteResponse = await callSharedUtil(
    "tslib-putRecords",
    taskWriteRequest,
  );

  // create assignments
  const assignmentWriteRequest = {
    authObj: authObj,
    recordType: "Projecttaskassign",
    writeObj: assignmentObjArray,
  };

  const assignmentWriteResponse = await callSharedUtil(
    "tslib-putRecords",
    assignmentWriteRequest,
  );

  projectCalculations.proj_direct_gm_percent__c =
    projectCalculations.proj_direct_gm__c / projectCalculations.proj_directs__c;
  projectCalculations.proj_project_gm_percent__c =
    projectCalculations.proj_project_gm__c /
    projectCalculations.proj_contract_value__c;

  const projectUpdateDetails = {
    authObj: authObj,
    recordType: "Project",
    writeObj: projectCalculations,
  };

  const projectUpdate = await callSharedUtil(
    "tslib-putRecords",
    projectUpdateDetails,
  );
};

function accumulateProjectTotals(record, projectCalculations) {
  const totalBid = parseFloat(record["Total Bid"]) || 0;
  const totalCost = parseFloat(record["Total Cost"]) || 0;

  projectCalculations.proj_total_hours__c +=
    parseFloat(record["total hours"]) || 0;

  if (record["Budget Category"] === "Directs") {
    projectCalculations.proj_directs__c += totalBid;
    projectCalculations.proj_total_direct__c += totalBid;
    projectCalculations.proj_contract_value__c += totalBid;
    projectCalculations.proj_direct_cost__c += totalCost;
    projectCalculations.proj_total_cost__c += totalCost;
    projectCalculations.proj_direct_gm__c += totalBid - totalCost;
    projectCalculations.proj_project_gm__c += totalBid - totalCost;
  }

  if (record["Budget Category"] === "PT") {
    projectCalculations.proj_pt__c += totalBid;
    projectCalculations.proj_pt_total__c += totalBid;
    projectCalculations.proj_contract_value__c += totalBid;
    projectCalculations.proj_pt_cost__c += totalCost;
    projectCalculations.proj_total_cost__c += totalCost;
    projectCalculations.proj_project_gm__c += totalBid - totalCost;
  }

  if (record["Budget Cateogry"] === "Fees") {
    projectCalculations.proj_pt_fees__c += totalBid;
    projectCalculations.proj_pt_total__c += totalBid;
    projectCalculations.proj_contract_value__c += totalBid;
    projectCalculations.proj_pt_cost__c += totalCost;
    projectCalculations.proj_total_cost__c += totalCost;
    projectCalculations.proj_project_gm__c += totalBid - totalCost;
  }

  if (record["Budget Category"] === "Investigator Grants") {
    projectCalculations.proj_ig__c += totalBid;
    projectCalculations.proj_contract_value__c += totalBid;
    projectCalculations.proj_ig_cost__c += totalCost;
    projectCalculations.proj_total_cost__c += totalCost;
    projectCalculations.proj_project_gm__c += totalBid - totalCost;
  }
}

async function test() {
  const result = await handler({
    body: '{"fileId":19}',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
