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
  taskObjArray,
  assignmentObjArray,
) {
  const deleteResponse = await deleteExistingTasks(projectRecord.id);

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i]["Header"]?.length > 0) {
      let matchingPhaseObject = phaseObjArray.find(
        (phase) => phase.name === fileLines[i]["Header"],
      );

      if (matchingPhaseObject === undefined) {
        // the phase has not been encountered yet
        const phaseExtId = `proj${projectRecord.id}_phase${fileLines[i]["Header"]}`;
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
        const taskExtId = `proj${projectRecord.id}_task${fileLines[i]["Unit Number"]}`;
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
          default_category: {
            value: fileLines[i]["Revenue Account"],
            lookupBy: "name",
            inTable: "Category",
          },
          id_number: fileLines[i]["Unit Number"],
          unit_basis__c: fileLines[i]["Unit Basis"],
          number_units__c: fileLines[i]["# of Units"],

          projecttask_typeid: 2,
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
}

async function calculateUnitPricePer(projId) {
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
      let assignmentTotal = 0;
      for (const assignmentRecord of assignmentRecords) {
        assignmentTotal += parseFloat(assignmentRecord.assign_bid__c);
      }

      const unitPrice =
        taskRecord.number_units__c !== 0
          ? assignmentTotal / taskRecord.number_units__c
          : 0;
      const taskUpdateDetails = {
        authObj: authObj,
        recordType: "Projecttask",
        writeObj: {
          id: taskRecord.id,
          unit_total_bid__c: assignmentTotal,
          unit_price_per__c: unitPrice,
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
          categoryid: taskRecord.default_category,
          name: `Billing rule for ${taskRecord.name}`,
          project_task_id: taskRecord.id,
          projectid: projId,
        },
      };

      const billingRuleUpdate = await callSharedUtil(
        "tslib-putRecords",
        billingRuleDetails,
      );

      /*const uprateDetails = {
        authObj: authObj,
        recordType: "Uprate",
        writeObj: {
          categoryid: taskRecord.default_category,
          userid: 251,
          rate: unitPrice,
          project_billing_ruleid: billingRuleUpdate[0].id,
        },
      };

      const uprateAdd = await callSharedUtil(
        "tslib-putRecords",
        billingRuleDetails,
      );*/
    }
  }
}
async function updateBidGridValues(
  newCsv,
  projectRecord,
  projectCalculations,
  phaseObjArray,
  taskObjArray,
  assignmentObjArray,
) {
  const previousFileRaw = await getAttachment(
    projectRecord.previousBidGridAttachmentId__c,
  );
  const originalCsv = atob(previousFileRaw.base64_data);

  const fieldDefinitions = [
    {
      entity: "Projecttask (Phase)",
      fields: [],
      key: "Header",
    },
    {
      entity: "Projecttask",
      fields: [
        "Budget Category",
        "Revenue Account",
        "Unit Name",
        "Unit Basis",
        "# of Units",
      ],
      key: "Unit Number",
    },
    {
      entity: "Projecttaskassign",
      fields: [
        "Team",
        "Functional Area",
        "Total Hours",
        "Total Cost",
        "Total Bid",
      ],
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

  await processPhaseUpdates(projectRecord, phaseInfo, phaseObjArray);
  await processTaskUpdates(projectRecord, taskInfo, taskObjArray);
  await processAssignmentUpdates(
    projectRecord,
    assignmentInfo,
    assignmentObjArray,
  );

  /*
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
  */
}

async function processPhaseUpdates(projectRecord, phaseInfo, phaseObjArray) {
  for (const phaseAdded of phaseInfo.added) {
    const phaseExtId = `proj${projectRecord.id}_phase${phaseAdded.row["Header"]}`;
    const newPhaseObj = {
      projectid: projectRecord.id,
      name: phaseAdded.row["Header"],
      is_a_phase: 1,
      externalid: phaseExtId,
    };
    phaseObjArray.push(newPhaseObj);
  }

  // phaseModified can not be determined -- it'll show up as an add or a delete

  /*
  for (const phaseDeleted of phaseInfo.deleted) {
    const phaseExtId = `proj${projectRecord.id}_phase${phaseDeleted.row["Header"]}`;
    const phaseObjToBeDeleted = {
      projectid: projectRecord.id,
      name: phaseAdded.row["Header"],
      is_a_phase: 1,
      externalid: phaseExtId,
    };
    phaseObjArray.push(newPhaseObj);
  }
    */
}

async function processTaskUpdates(projectRecord, taskInfo, taskObjArray) {
  for (const taskDeletion of taskInfo.deleted) {
    console.log("here");
  }

  const allTaskChanges = [
    ...(taskInfo.added ?? []).map((task) => ({ task, isModified: false })),
    ...(taskInfo.modified ?? []).map((task) => ({ task, isModified: true })),
  ];
  for (const { task, isModified } of allTaskChanges) {
    const taskExtId = `proj${projectRecord.id}_task${task.row["Unit Number"]}`;
    const phaseExtId = `proj${projectRecord.id}_phase${task.row["Header"]}`;
    const newTaskObj = {
      projectid: projectRecord.id,
      name: task.row["Unit Name"],
      parentid: {
        value: phaseExtId,
        lookupBy: "externalid",
        inTable: "Projecttask",
      },
      unit_budget_cat__c: task.row["Budget Category"],
      service: {
        value: task.row["Revenue Account"],
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
      costCenter: {
        value: assignment.row["Team"],
        lookupBy: "name",
        inTable: "Costcenter",
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
      planned_hours: assignment.row["total hours"],
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
  const fileId = bodyJSON.fileId;

  const attachmentRecord = await getAttachment(fileId);

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
  const projectRecords = await callSharedUtil(
    "tslib-getRecords",
    sppProjectRequest,
  );
  const projectRecord = projectRecords?.[0];
  console.log(`Project ID: ${projectRecord.id}`);

  const phaseObjArray = [];
  const taskObjArray = [];
  const assignmentObjArray = [];

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

  /*if (projectRecord.previousBidGridAttachmentId__c) {
    await updateBidGridValues(
      base64,
      projectRecord,
      projectCalculations,
      phaseObjArray,
      taskObjArray,
      assignmentObjArray,
    );
  } else {
    await newBidGridLoad(
      fileLines,
      projectRecord,
      projectCalculations,
      phaseObjArray,
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
*/
  await calculateUnitPricePer(projectRecord.id);

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
    body: '{"fileId":103}',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
