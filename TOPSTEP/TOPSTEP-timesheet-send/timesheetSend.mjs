import ExcelJS from "exceljs";
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";

const sesClient = new SESClient({ region: "us-east-2" });
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);

const authObj = {
  company: "top step consulting llc",
  instance: "sb",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * email function
 */
const sendTimesheetEmail = async ({
  toAddress,
  fromAddress = "noreply@addolution.com",
  attachmentBuffer,
  fileName = "timesheet.xlsm",
}) => {
  const base64Attachment = attachmentBuffer.toString("base64");
  const boundary = `----=_boundary_${Date.now()}`;

  const rawMessage = [
    `From: SPP Timesheet <${fromAddress}>`,
    `To: ${toAddress}`,
    `Subject: Your Timesheet is Ready`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Your timesheet is attached. Fill in your hours and notes, then click the Submit button when complete.`,
    ``,
    `--${boundary}`,
    `Content-Type: application/vnd.ms-excel.sheet.macroEnabled.12; name="${fileName}"`,
    `Content-Disposition: attachment; filename="${fileName}"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Attachment,
    `--${boundary}--`,
  ].join("\r\n");

  const command = new SendRawEmailCommand({
    RawMessage: {
      Data: Buffer.from(rawMessage),
    },
  });

  await sesClient.send(command);
};
/*
 * getUsers - pulls all users from SPP where sendTimesheet__c is checked
 */

async function getUsers() {
  const sppUserRequest = {
    authObj: authObj,
    recordType: "User",
    criteriaObj: {
      sendTimesheet__c: 1,
    },
    limit: 1000,
    fields: "id,addr",
  };

  const userRecords = await callSharedUtil("tslib-getRecords", sppUserRequest);

  return userRecords;
}

/*
 * getTasks - pulls all customer, project, and task names and ids that the provided user is assigned to
 */

async function getTasks(userid) {
  const sppAssignmentRequest = {
    authObj: authObj,
    recordType: "Projecttaskassign",
    criteriaObj: {
      closed_for_timesheet: 0,
      userid: userid,
    },
    limit: 10,
    fields: "projecttaskid",
  };

  const assignmentRecords = await callSharedUtil(
    "tslib-getRecords",
    sppAssignmentRequest,
  );

  const taskRecords = assignmentRecords?.length
    ? await Promise.all(
        assignmentRecords.filter(Boolean).map(async (assignment) => {
          const sppTaskRequest = {
            authObj: authObj,
            recordType: "Projecttask",
            criteriaObj: {
              id: assignment.projecttaskid,
            },
            limit: 1,
            fields: "id,projectid,customerid,name",
            /*lookups: [
              {
                inTable: "Customer",
                returnField: "name",
                idFieldInData: "customerid",
              },
              {
                inTable: "Project",
                returnField: "name",
                idFieldInData: "projectid",
              },
            ],*/
          };

          const taskRecord = await callSharedUtil(
            "tslib-getRecords",
            sppTaskRequest,
          );

          return taskRecord;
        }),
      )
    : [];

  return taskRecords;
}
/*
 * create initial Excel doc
 */

async function createSpreadsheet(taskData) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Timesheet");

  // Define columns
  sheet.columns = [
    { header: "Customer", key: "customer", width: 30 },
    { header: "Project", key: "project", width: 30 },
    { header: "Task", key: "task", width: 30 },
    { header: "Date", key: "date", width: 15 },
    { header: "Hours", key: "hours", width: 10 },
    { header: "Notes", key: "notes", width: 40 },
    // hidden SPP ID columns
    { header: "CustomerId", key: "customerid", width: 10, hidden: true },
    { header: "ProjectId", key: "projectid", width: 10, hidden: true },
    { header: "TaskId", key: "taskid", width: 10, hidden: true },
  ];

  // Add your data rows
  for (const dataRow of taskData) {
    sheet.addRow({
      customer: dataRow.customer_name,
      project: dataRow.project_name,
      task: dataRow.name,
      customerid: dataRow.customerid,
      projectid: dataRow.projectid,
      taskid: dataRow.id,
    });
  }

  return workbook;
}
/*
 * main handler
 */

export const handler = async (event) => {
  const usersToProcess = await getUsers();
  for (const user of usersToProcess) {
    const email = user.addr.Address.email;
    const userTasks = await getTasks(user.id);
    const timesheet = await createSpreadsheet(userTasks);

    const outputBuffer = await timesheet.xlsx.writeBuffer();

    await sendTimesheetEmail({
      toAddress: "jim@addolution.com",
      attachmentBuffer: outputBuffer,
      fileName: `timesheet.xlsx`,
    });
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify("Hello from Lambda!"),
  };
  return response;
};

/*
 * test function
 */

async function test() {
  const result = await handler({});
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
