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
    limit: "1000,10",
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
 *  set timesheet start date
 */

function getPreviousSunday() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday
  const daysToSubtract = dayOfWeek === 0 ? 0 : dayOfWeek;
  today.setDate(today.getDate() - daysToSubtract);
  return today.toISOString().substring(0, 10);
}

/*
 * create initial Excel doc
 */

async function createSpreadsheet(taskData) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Timesheet");
  const user = { id: 37 };
  const someToken = "oip24l2wiw";
  const submitUrl = `https://your-function-url.lambda-url.us-east-2.on.aws/?userId=${user.id}&token=${someToken}`;

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

  const linkCell = sheet.getRow(1).getCell(10);

  linkCell.value = {
    text: "Click here to submit your timesheet",
    hyperlink: submitUrl,
  };

  linkCell.font = {
    bold: true,
    size: 14,
    color: { argb: "FF0000FF" }, // blue, optional
    underline: true, // makes it look more like a link, optional
  };

  ["A1", "B1", "C1", "D1", "E1", "F1"].forEach((cellRef) => {
    sheet.getCell(cellRef).font = {
      bold: true,
      underline: true,
    };
  });

  // Add your data rows
  const currentDate = new Date(getPreviousSunday());
  for (let i = 0; i < 7; i++) {
    let custName = "";
    let projName = "";

    for (const [index, dataRow] of taskData.entries()) {
      switch (index) {
        case 0:
        case 1:
        case 2:
          custName = "Exemplary Labs";
          projName = "Implementation Project";
          break;
        default:
          custName = "Stellent";
          projName = "Jira integration";
          break;
      }
      sheet.addRow({
        customer: dataRow.customer_name || custName,
        project: dataRow.project_name || projName,
        task: dataRow.name,
        customerid: dataRow.customerid,
        projectid: dataRow.projectid,
        taskid: dataRow.id,
        date: currentDate.toISOString().substring(0, 10),
      });
    }
    sheet.addRow();
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return workbook;
}
/*
 * main handler
 */

export const handler = async (event) => {
  console.log(`Event: ${JSON.stringify(event)}`);
  let bodyText = "no action set";
  if (event.action === "send") {
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
    bodyText = "send executed";
  } else if (event.action === "receive") {
    bodyText = `
        <html>
            <body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
                <div style="text-align: center;">
                    <h1 style="color: green;">✓ Timesheet Submitted</h1>
                    <p>Your timesheet has been successfully submitted. You may close this window.</p>
                </div>
            </body>
        </html>
    `;
  }
  const response = {
    statusCode: 200,
    body: bodyText,
  };
  return response;
};

/*
 * test function
 */

async function test() {
  const result = await handler({ action: "receive" });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
