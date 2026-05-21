import { parse } from "csv-parse/sync";

const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../shared/sharedUtils.js";

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
  };

  const taskRecords = await callSharedUtil("tslib-getRecords", sppTaskRequest);
  console.log("tasks: ", JSON.stringify(taskRecords));

  // finish this
  return;
}

export const handler = async (event) => {
  console.log(JSON.stringify(event));
  const bodyJSON = JSON.parse(event.body);
  const fileId = bodyJSON.fileId;
  console.log(`fileId: ${fileId}`);
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

  const base64 = atob(attachmentRecord.Attachment.base64_data);
  const fileLines = parse(base64, {
    columns: true,
    skip_empty_lines: true,
  });
  const phaseNames = [];
  console.log(`fileLines: ${JSON.stringify(fileLines)}`);
  for (let i = 0; i < fileLines.length; i++) {
    const projectName = fileLines[i]["Project ID"];
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
    console.log(`Project ID: ${projectRecord.Project.id}`);

    const deleteResponse = await deleteExistingTasks(projectRecord.Project.id);

    const sppPhaseWrite = {
      authObj: authObj,
      recordType: "Projecttask",
      writeObj: {
        projectid: projectRecord.Project.id,
        name: fileLines[i]["Header"],
        is_a_phase: 1,
      },
    };
    let matchingObject = phaseNames.find(
      (phase) => sppPhaseWrite.writeObj.name === fileLines[i]["Header"],
    );
    if (matchingObject === undefined) {
      const phaseCreate = await callSharedUtil(
        "tslib-putRecords",
        sppPhaseWrite,
      );
      console.log(`Phase ID: ${phaseCreate.Projecttask.id}`);
      const sppPhaseObj = {
        id: phaseCreate.Projecttask.id,
        name: fileLines[i]["Header"],
      };
      phaseNames.push(sppPhaseObj);
      matchingObject = sppPhaseObj;
    }

    const sppTaskWrite = {
      authObj: authObj,
      recordType: "Projecttask",
      writeObj: {
        projectid: projectRecord.Project.id,
        name: fileLines[i]["Unit Name"],
        is_a_phase: "",
        parentid: matchingObject.id,
        unit_budget_cat__c: fileLines[i]["Budget Category"],
        service: {
          value: fileLines[i]["Revenue Account"],
          lookupBy: "name",
          inTable: "Category",
        },
        id_number: fileLines[i]["Unit Number"],
        unit_basis__c: fileLines[i]["Unit Basis"],
        number_units__c: fileLines[i]["# of Units"],
      },
    };
    const taskCreate = await callSharedUtil("tslib-putRecords", sppTaskWrite);
    console.log(`Task ID: ${taskCreate.Projecttask.id}`);
    const sppAssignmentWrite = {
      authObj: authObj,
      recordType: "Projecttaskassign",
      writeObj: {
        projectid: projectRecord.Project.id,
        projecttaskid: taskCreate.Projecttask.id,
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
      },
    };
    const assignCreate = await callSharedUtil(
      "tslib-putRecords",
      sppAssignmentWrite,
    );
    console.log(`Assign ID: ${assignCreate.Projecttaskassign.id}`);
    /*const response = {
      statusCode: 200,
      body: `fileId: ${fileId}`,
  };
  return response;*/
  }
};

// at the bottom of getRecords.mjs

async function test() {
  const result = await handler({
    body: '{"fileId":18}',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
