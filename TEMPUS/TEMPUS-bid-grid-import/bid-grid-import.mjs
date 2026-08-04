import { parse } from "csv-parse/sync";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({ region: "us-east-2" });
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

async function getAttachment(fileId) {
  const sppAttachmentRequest = {
    authObj: authObj,
    recordType: "Attachment",
    criteriaObj: {
      id: fileId,
    },
    limit: 1,
  };
  const attachmentRecords = await callSharedUtil(
    "tslib-getRecords",
    sppAttachmentRequest,
  );

  return attachmentRecords?.[0];
}

async function newBidGridLoad(
  fileLines,
  projectRecord,
  projectCalculations,
  phaseObjArray,
  subPhaseObjArray,
  taskObjArray,
  assignmentObjArray,
) {
  // const deleteResponse = await deleteExistingTasks(projectRecord.id);

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i]["Phase"]?.length > 0) {
      let matchingPhaseObject = phaseObjArray.find(
        (phase) => phase.name === fileLines[i]["Phase"],
      );

      if (matchingPhaseObject === undefined) {
        // the phase has not been encountered yet
        const phaseExtId = `proj${projectRecord.id}_phase${fileLines[i]["Phase"]}`;
        const newPhaseObj = {
          projectid: projectRecord.id,
          name: fileLines[i]["Phase"],
          is_a_phase: 1,
          externalid: phaseExtId,
        };

        phaseObjArray.push(newPhaseObj);
        matchingPhaseObject = newPhaseObj;
      }

      let matchingSubPhaseObject = subPhaseObjArray.find(
        (subPhase) =>
          subPhase.externalid ===
          `proj${projectRecord.id}_phase${fileLines[i]["Phase"]}_subphase${fileLines[i]["Sub-phase"]}`,
      );

      if (matchingSubPhaseObject === undefined) {
        // the sub-phase has not been encountered yet
        const subPhaseExtId = `proj${projectRecord.id}_phase${fileLines[i]["Phase"]}_subphase${fileLines[i]["Sub-phase"]}`;
        const newSubPhaseObj = {
          projectid: projectRecord.id,
          name: fileLines[i]["Sub-phase"],
          is_a_phase: 1,
          externalid: subPhaseExtId,
          parentid: {
            value: matchingPhaseObject.externalid,
            lookupBy: "externalid",
            inTable: "Projecttask",
          },
        };

        subPhaseObjArray.push(newSubPhaseObj);
        matchingSubPhaseObject = newSubPhaseObj;
      }

      let matchingTaskObject = taskObjArray.find(
        (task) => task.name === fileLines[i]["Unit Name"],
      );

      if (matchingTaskObject === undefined) {
        // the task has not been encountered yet
        const taskExtId = `proj${projectRecord.id}_task${fileLines[i]["Unit Number"]}`;
        const newTaskObj = {
          projectid: projectRecord.id,
          name: fileLines[i]["Unit Name"],
          is_a_phase: "",
          cost_centerid: {
            value: fileLines[i]["Team"],
            lookupBy: "name",
            inTable: "Costcenter",
          },
          parentid: {
            value: matchingSubPhaseObject.externalid,
            lookupBy: "externalid",
            inTable: "Projecttask",
          },
          unit_budget_cat__c: fileLines[i]["Budget Category"],
          default_category: {
            value: fileLines[i]["Item Name"],
            lookupBy: "name",
            inTable: "Category",
          },
          id_number: fileLines[i]["Unit Number"],
          unit_basis__c: fileLines[i]["Unit Basis"],
          number_units__c: fileLines[i]["# of Units"],
          unit_total_cost__c: fileLines[i]["Total Cost"], // will get overridden if there are task assignments
          unit_total_bid__c: fileLines[i]["Total Bid"], // will get overridden if there are task assignments
          projecttask_typeid: 2,
          externalid: taskExtId,
        };

        taskObjArray.push(newTaskObj);
        matchingTaskObject = newTaskObj;
      }

      if (fileLines[i]["Bid Role"]) {
        const newAssignmentObj = {
          projectid: projectRecord.id,
          projecttaskid: {
            value: matchingTaskObject.externalid,
            lookupBy: "externalid",
            inTable: "Projecttask",
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
          planned_hours:
            fileLines[i]["Total Hours"] || fileLines[i]["total hours"] || 0,
          assign_cost__c: fileLines[i]["Total Cost"],
          assign_bid__c: fileLines[i]["Total Bid"],
        };

        assignmentObjArray.push(newAssignmentObj);
      }

      accumulateProjectTotals(fileLines[i], projectCalculations);
    }
  }
}

/*async function calculateUnitPricePer(projId) {
  const sppTaskRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    criteriaObj: {
      projectid: projId,
    },
    limit: 1000,
  };
  const taskRecords = await callSharedUtil("tslib-getRecords", sppTaskRequest);

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

      const uprateAdd = await callSharedUtil("tslib-putRecords", uprateDetails);
    }
  }
}*/
// calculateUnitPricePer has been migrated to the standalone
// TEMPUS-calculate-unit-price Lambda function.
async function calculateUnitPricePer(projId) {
  const command = new InvokeCommand({
    FunctionName:
      "arn:aws:lambda:us-east-2:776528084998:function:TEMPUS-calculate-unit-price",
    InvocationType: "RequestResponse",
    Payload: JSON.stringify({ projId }), // adjust shape to match target handler's expected event
  });

  const response = await lambdaClient.send(command); // lowercase — the instance, not the class

  const responsePayload = JSON.parse(
    Buffer.from(response.Payload).toString("utf-8"),
  );

  if (response.FunctionError) {
    console.error(
      `TEMPUS-calculate-unit-price threw an error: ${JSON.stringify(responsePayload)}`,
    );
    throw new Error(
      `calculateUnitPricePer Lambda invocation failed: ${responsePayload?.errorMessage ?? "unknown error"}`,
    );
  }

  console.log(`responsePayload: ${JSON.stringify(responsePayload)}`);
  return responsePayload;
}

async function getSPPRecordFromStore(dataStore, searchObject) {
  const searchObjectEntries = Object.entries(searchObject);
  let dataStoreRecord = dataStore.find((storedInfo) =>
    searchObjectEntries.every(([k, v]) => storedInfo[k] === v),
  );

  if (!dataStoreRecord) {
    const { recordType: searchObjectType, ...searchObjectWithoutType } =
      searchObject;
    const sppRequest = {
      authObj: authObj,
      recordType: searchObjectType,
      criteriaObj: searchObjectWithoutType,
      limit: 1,
    };

    const sppResponse = await callSharedUtil("tslib-getRecords", sppRequest);

    if (sppResponse.length === 1) {
      dataStoreRecord = {
        recordType: searchObjectType,
        ...sppResponse[0],
      };
      dataStore.push(dataStoreRecord);
    }
  }
  return dataStoreRecord;
}

async function updateBidGridValues(
  fileLines,
  newCsv,
  projectRecord,
  projectCalculations,
  phaseObjArray,
  taskObjArray,
  assignmentObjArray,
) {
  const dataStore = [];

  //let originalCsv =
  //"Project ID,Budget Category,Revenue Account,Team,Functional Area,Tab,Header,Unit Number,Unit Name,Unit Basis,# of Units,Bid Role,total hours,Total Cost,Total Bid\r\n";
  let originalCsv =
    "SPP_Project,Budget Category,Item Internal ID,Item Name,Phase,Sub-phase,Unit Number,Unit Name,Unit Basis,# of Units,Team,Functional Area,Bid Role,Total Hours,Total Cost,Total Bid\r\n";
  // csv field updates -- 7/29
  const sppTaskRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    criteriaObj: {
      projectid: projectRecord.id,
    },
    limit: 1000,
  };
  const taskRecords = await callSharedUtil("tslib-getRecords", sppTaskRequest);

  for (const task of taskRecords) {
    const categoryRecord = await getSPPRecordFromStore(dataStore, {
      recordType: "Category",
      id: task.default_category,
    });
    const costCenterRecord = await getSPPRecordFromStore(dataStore, {
      recordType: "Costcenter",
      id: task.cost_centerid,
    });
    const phaseRecord = await getSPPRecordFromStore(dataStore, {
      recordType: "Projecttask",
      id: task.parentid,
    });

    const sppAssignmentRequest = {
      authObj: authObj,
      recordType: "Projecttaskassign",
      criteriaObj: {
        projecttaskid: task.id,
      },
      limit: 1000,
    };
    const assignmentRecords = await callSharedUtil(
      "tslib-getRecords",
      sppAssignmentRequest,
    );

    if (assignmentRecords?.length > 0) {
      for (const assignment of assignmentRecords) {
        const departmentRecord = await getSPPRecordFromStore(dataStore, {
          recordType: "Department",
          id: assignment.assign_functional_area__c,
        });
        const userRecord = await getSPPRecordFromStore(dataStore, {
          recordType: "User",
          id: assignment.userid,
        });

        const field = [];
        /*field[0] = projectRecord.name; // Project ID
        field[1] = task.unit_budget_cat__c; // Budget Category
        field[2] = categoryRecord?.name || ""; // Revenue Account
        field[3] = costCenterRecord?.name || ""; // Team
        field[4] = departmentRecord?.name || ""; // Functional Area
        field[5] = 1; // Tab
        field[6] = phaseRecord?.name || ""; // Header
        field[7] = task.id_number; // Unit Number
        field[8] = task.name; // Unit Name
        field[9] = task.unit_basis__c; // Unit Basis
        field[10] = task.number_units__c; // # of Units
        field[11] = userRecord.name; // Bid Role
        field[12] = assignment.planned_hours; // total hours
        field[13] = assignment.assign_cost__c; // Total Cost
        field[14] = assignment.assign_bid__c; // Total Bid*/

        // NEW MAPPING -- 7/29
        field[0] = projectRecord.name; // SPP_Project
        field[1] = task.unit_budget_cat__c; // Budget Category
        //field[2] = categoryRecord?.name || ""; // Item Internal ID
        field[3] = categoryRecord?.name || ""; // Item Name
        field[4] = phaseRecord?.name || ""; // Header
        field[5] = phaseRecord?.name || ""; // Sub-phase
        field[6] = task.id_number; // Unit Number
        field[7] = task.name; // Unit Name
        field[8] = task.unit_basis__c; // Unit Basis
        field[9] = task.number_units__c; // # of Units
        field[10] = costCenterRecord?.name || ""; // Team
        field[11] = departmentRecord?.name || ""; // Functional Area
        field[12] = userRecord.name; // Bid Role
        field[13] = assignment.planned_hours; // total hours
        field[14] = assignment.assign_cost__c; // Total Cost
        field[15] = assignment.assign_bid__c; // Total Bid

        originalCsv += field.map(csvField).join(",") + "\r\n";
      }
    } else {
      // no task assignments
      const field = [];
      /*field[0] = projectRecord.name; // SPP_Project
      field[1] = task.unit_budget_cat__c; // Budget Category
      //field[2] = categoryRecord?.name || ""; // Item Internal ID
      field[3] = categoryRecord?.name || ""; // Item Name
      field[4] = costCenterRecord?.name || ""; // Team
      field[5] = ""; // Functional Area -- blank because no assignment
      field[6] = 1; // Tab
      field[7] = phaseRecord?.name || ""; // Header
      field[8] = task.id_number; // Unit Number
      field[9] = task.name; // Unit Name
      field[10] = task.unit_basis__c; // Unit Basis
      field[11] = task.number_units__c; // # of Units
      field[12] = ""; // Bid Role -- blank because no assignment
      field[13] = ""; // total hours -- blank because no assignment
      field[13] = task.unit_total_cost__c; // Total Cost from Task
      field[14] = task.unit_total_bid__c; // Total Bid from Task*/

      // NEW MAPPING -- 7/29
      field[0] = projectRecord.name; // SPP_Project
      field[1] = task.unit_budget_cat__c; // Budget Category
      //field[2] = categoryRecord?.name || ""; // Item Internal ID
      field[3] = categoryRecord?.name || ""; // Item Name
      field[4] = phaseRecord?.name || ""; // Header
      field[5] = phaseRecord?.name || ""; // Sub-phase
      field[6] = task.id_number; // Unit Number
      field[7] = task.name; // Unit Name
      field[8] = task.unit_basis__c; // Unit Basis
      field[9] = task.number_units__c; // # of Units
      field[10] = costCenterRecord?.name || ""; // Team
      field[11] = departmentRecord?.name || ""; // Functional Area
      field[12] = userRecord.name; // Bid Role
      field[13] = assignment.planned_hours; // total hours
      field[14] = assignment.assign_cost__c; // Total Cost
      field[15] = assignment.assign_bid__c; // Total Bid

      originalCsv += field.map(csvField).join(",") + "\r\n";
    }
  }

  const fieldDefinitions = [
    {
      entity: "Projecttask (Phase)",
      fields: [],
      key: "Header",
    },
    {
      entity: "Projecttask",
      fields: [
        "Team",
        "Budget Category",
        //"Revenue Account",
        "Item Name",
        "Unit Name",
        "Unit Basis",
        "# of Units",
      ],
      key: "Unit Number",
    },
    {
      entity: "Projecttaskassign",
      fields: ["Functional Area", "Total Hours", "Total Cost", "Total Bid"],
      key: ["Unit Number", "Bid Role"],
    },
  ];

  const diffResults = await callSharedUtil("tslib-csvDiff", {
    originalCsv,
    newCsv,
    fieldDefinitions,
  });

  //return diffResults;
  const phaseInfo = diffResults[0]["Projecttask (Phase)"];
  const taskInfo = diffResults[1]["Projecttask"];
  const assignmentInfo = diffResults[2]["Projecttaskassign"];

  //await processPhaseUpdates(projectRecord, phaseInfo, phaseObjArray); -- not needed as of 7/30
  await processTaskUpdates(projectRecord, taskInfo, taskObjArray);
  await processAssignmentUpdates(
    projectRecord,
    assignmentInfo,
    assignmentObjArray,
  );

  for (let i = 0; i < fileLines.length; i++) {
    accumulateProjectTotals(fileLines[i], projectCalculations);
  }
}

async function processPhaseUpdates(projectRecord, phaseInfo, phaseObjArray) {
  for (const phaseAdded of phaseInfo.added) {
    const phaseExtId = `proj${projectRecord.id}_phase${phaseAdded.row["Phase"]}`;
    const newPhaseObj = {
      projectid: projectRecord.id,
      name: phaseAdded.row["Phase"],
      is_a_phase: 1,
      externalid: phaseExtId,
    };
    phaseObjArray.push(newPhaseObj);
  }

  // phaseModified can not be determined -- it'll show up as an add or a delete

  /*
  for (const phaseDeleted of phaseInfo.deleted) {
    const phaseExtId = `proj${projectRecord.id}_phase${phaseDeleted.row["Phase"]}`;
    const phaseObjToBeDeleted = {
      projectid: projectRecord.id,
      name: phaseAdded.row["Phase"],
      is_a_phase: 1,
      externalid: phaseExtId,
    };
    phaseObjArray.push(newPhaseObj);
  }
    */
}

async function processTaskUpdates(projectRecord, taskInfo, taskObjArray) {
  for (const taskDeletion of taskInfo.deleted) {
    if (taskDeletion.row.Phase !== "") {
      console.log("here");
    } else {
      console.log("there");
    }
  }

  const allTaskChanges = [
    ...(taskInfo.added ?? []).map((task) => ({ task, isModified: false })),
    ...(taskInfo.modified ?? []).map((task) => ({ task, isModified: true })),
  ];
  for (const { task, isModified } of allTaskChanges) {
    const taskExtId = `proj${projectRecord.id}_task${task.row["Unit Number"]}`;
    const phaseExtId = `proj${projectRecord.id}_phase${task.row["Phase"]}`;
    const newTaskObj = {
      projectid: projectRecord.id,
      name: task.row["Unit Name"],
      cost_centerid: {
        value: task.row["Team"],
        lookupBy: "name",
        inTable: "Costcenter",
      },
      parentid: {
        value: phaseExtId,
        lookupBy: "externalid",
        inTable: "Projecttask",
      },
      unit_budget_cat__c: task.row["Budget Category"],
      default_category: {
        value: task.row["Item Name"],
        lookupBy: "name",
        inTable: "Category",
      },
      id_number: task.row["Unit Number"],
      unit_basis__c: task.row["Unit Basis"],
      number_units__c: task.row["# of Units"],
      externalid: taskExtId,
      ...(isModified && {
        id: {
          value: taskExtId,
          lookupBy: "externalid",
          inTable: "Projecttask",
        },
      }),
    };
    taskObjArray.push(newTaskObj);
  }
}

async function processAssignmentUpdates(
  projectRecord,
  assignmentInfo,
  assignmentObjArray,
) {
  for (const deletedAssignment of assignmentInfo.deleted) {
    const identifier = deletedAssignment["Unit Number|Bid Role"];
    const taskIdNumber = identifier.substring(0, identifier.indexOf("|"));
    const userName = identifier.substring(
      identifier.indexOf("|") + 1,
      identifier.length,
    );

    const sppTaskRequest = {
      authObj: authObj,
      recordType: "Projecttask",
      criteriaObj: {
        projectid: projectRecord.id,
        id_number: taskIdNumber,
      },
      limit: 1,
    };
    const taskRecords = await callSharedUtil(
      "tslib-getRecords",
      sppTaskRequest,
    );

    if (taskRecords && taskRecords.length > 0) {
      const taskId = taskRecords[0].id;
      const sppAssignmentRequest = {
        authObj: authObj,
        recordType: "Projecttaskassign",
        criteriaObj: {
          projecttaskid: taskId,
          userid: {
            value: userName,
            lookupBy: "name",
            inTable: "User",
          },
        },
        limit: 1,
      };
      const assignmentRecords = await callSharedUtil(
        "tslib-getRecords",
        sppAssignmentRequest,
      );

      if (assignmentRecords && assignmentRecords.length > 0) {
        const deleteRequest = {
          authObj: authObj,
          recordType: "Projecttaskassign",
          recordsToDelete: [assignmentRecords[0].id],
        };

        const deleteResponse = await callSharedUtil(
          "tslib-deleteRecords",
          deleteRequest,
        );

        console.log("here");
      }
    }
  }

  const allAssignmentChanges = [
    ...assignmentInfo.added.map((assignment) => ({
      assignment,
      isModified: false,
    })),
    ...assignmentInfo.modified.map((assignment) => ({
      assignment,
      isModified: true,
    })),
  ];

  for (const { assignment, isModified } of allAssignmentChanges) {
    const taskExtId = `proj${projectRecord.id}_task${assignment.row["Unit Number"]}`;
    let idValue;
    if (isModified) {
      const identifier = assignment["Unit Number|Bid Role"];
      const taskIdNumber = identifier.substring(0, identifier.indexOf("|"));
      const userName = identifier.substring(
        identifier.indexOf("|") + 1,
        identifier.length,
      );

      const sppTaskRequest = {
        authObj: authObj,
        recordType: "Projecttask",
        criteriaObj: {
          projectid: projectRecord.id,
          id_number: taskIdNumber,
        },
        limit: 1,
      };
      const taskRecords = await callSharedUtil(
        "tslib-getRecords",
        sppTaskRequest,
      );

      if (taskRecords && taskRecords.length > 0) {
        const taskId = taskRecords[0].id;
        const sppAssignmentRequest = {
          authObj: authObj,
          recordType: "Projecttaskassign",
          criteriaObj: {
            projecttaskid: taskId,
            userid: {
              value: userName,
              lookupBy: "name",
              inTable: "User",
            },
          },
          limit: 1,
        };
        const assignmentRecords = await callSharedUtil(
          "tslib-getRecords",
          sppAssignmentRequest,
        );

        if (assignmentRecords && assignmentRecords.length > 0) {
          idValue = assignmentRecords[0].id;
        }
      }
    }

    const newAssignmentObj = {
      projectid: projectRecord.id,
      projecttaskid: {
        value: taskExtId,
        lookupBy: "externalid",
        inTable: "Projecttask",
      },
      assign_functional_area__c: {
        value: assignment.row["Functional Area"],
        lookupBy: "name",
        inTable: "Department",
      },
      userid: {
        value: assignment.row["Bid Role"],
        lookupBy: "name",
        inTable: "User",
      },
      planned_hours:
        assignment.row["Total Hours"] || assignment.row["total hours"] || 0,
      assign_cost__c: assignment.row["Total Cost"],
      assign_bid__c: assignment.row["Total Bid"],
      ...(isModified && {
        id: idValue,
      }),
    };

    assignmentObjArray.push(newAssignmentObj);
  }
}

export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  const base64 = bodyJSON.base64;

  //const attachmentRecord = await getAttachment(fileId);

  //const base64 = atob(attachmentRecord.base64_data);
  const fileLines = parse(base64, {
    columns: true,
    skip_empty_lines: true,
  });

  const phaseNames = [];
  console.log(`headers: ${JSON.stringify(fileLines[0])}`);

  const projectName = fileLines[0]["SPP_Project"];
  const sppProjectRequest = {
    authObj: authObj,
    recordType: "Project",
    criteriaObj: {
      name: projectName,
    },
    limit: 1,
  };
  const projectRecords = await callSharedUtil(
    "tslib-getRecords",
    sppProjectRequest,
  );
  const projectRecord = projectRecords?.[0];
  console.log(`Project ID: ${projectRecord.id}`);

  const phaseObjArray = [];
  const taskObjArray = [];
  const assignmentObjArray = [];
  const subPhaseObjArray = [];

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
  // check for initial load complete box checked -- projectRecord.fieldName. If checked then update, otherwise proceed normally

  if (projectRecord.previousBidGridAttachmentId__c) {
    await updateBidGridValues(
      fileLines,
      base64,
      projectRecord,
      projectCalculations,
      phaseObjArray,
      subPhaseObjArray,
      taskObjArray,
      assignmentObjArray,
    );
  } else {
    await newBidGridLoad(
      fileLines,
      projectRecord,
      projectCalculations,
      phaseObjArray,
      subPhaseObjArray,
      taskObjArray,
      assignmentObjArray,
    );
  }

  // create phases
  if (phaseObjArray.length > 0) {
    const phaseWriteRequest = {
      authObj: authObj,
      recordType: "Projecttask",
      writeObj: phaseObjArray,
    };

    const phaseWriteResponse = await callSharedUtil(
      "tslib-putRecords",
      phaseWriteRequest,
    );
  }

  // create subphases
  if (subPhaseObjArray.length > 0) {
    const subPhaseWriteRequest = {
      authObj: authObj,
      recordType: "Projecttask",
      writeObj: subPhaseObjArray,
    };

    const subPhaseWriteResponse = await callSharedUtil(
      "tslib-putRecords",
      subPhaseWriteRequest,
    );
  }

  // create tasks
  if (taskObjArray.length > 0) {
    const taskWriteRequest = {
      authObj: authObj,
      recordType: "Projecttask",
      writeObj: taskObjArray,
    };

    const taskWriteResponse = await callSharedUtil(
      "tslib-putRecords",
      taskWriteRequest,
    );
  }

  // create assignments
  if (assignmentObjArray.length > 0) {
    const assignmentWriteRequest = {
      authObj: authObj,
      recordType: "Projecttaskassign",
      writeObj: assignmentObjArray,
    };

    const assignmentWriteResponse = await callSharedUtil(
      "tslib-putRecords",
      assignmentWriteRequest,
    );
  }

  // only run on original load
  if (!projectRecord.previousBidGridAttachmentId__c) {
    await calculateUnitPricePer(projectRecord.id);
  }

  projectCalculations.proj_direct_gm_percent__c =
    projectCalculations.proj_directs__c !== 0
      ? projectCalculations.proj_direct_gm__c /
        projectCalculations.proj_directs__c
      : 0;
  projectCalculations.proj_project_gm_percent__c =
    projectCalculations.proj_contract_value__c !== 0
      ? projectCalculations.proj_project_gm__c /
        projectCalculations.proj_contract_value__c
      : 0;
  projectCalculations.previousBidGridAttachmentId__c = fileId;

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

function csvField(value) {
  const s = String(value ?? "");
  return s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function accumulateProjectTotals(record, projectCalculations) {
  const totalBid = parseFloat(record["Total Bid"]) || 0;
  const totalCost = parseFloat(record["Total Cost"]) || 0;

  projectCalculations.proj_total_hours__c +=
    parseFloat(record["Total Hours"]) || parseFloat(record["total hours"]) || 0;

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

  if (record["Budget Category"] === "Fees") {
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
    body: '{"fileId":124}',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
