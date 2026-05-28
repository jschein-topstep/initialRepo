import ExcelJS from "exceljs";
import JSZip from "jszip";
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

async function createSpreadsheet(taskData, template) {
  const buffer = Buffer.from(template, "base64");
  const zip = await JSZip.loadAsync(buffer);
  //const sheetXml = await zip.file("xl/worksheets/sheet1.xml").async("string");

  const userId = 37;
  const someToken = "oip24l2wiw";
  const submitUrl = `https://your-function-url.lambda-url.us-east-2.on.aws/?userId=${userId}&token=${someToken}`;

  let custName = "";
  let projName = "";
  const dataRows = taskData
    .map((row, index) => {
      const rowNum = index + 5; // start at row 2 (row 1 = headers)
      switch (rowNum) {
        case 2:
        case 3:
        case 4:
          custName = "Exemplary Labs";
          projName = "Implementation Project";
          break;
        default:
          custName = "Stellent";
          projName = "Jira integration";
          break;
      }
      return `
        <row r="${rowNum}">
            <c r="A${rowNum}" t="str"><v>${escapeXml(custName)}</v></c>
            <c r="B${rowNum}" t="str"><v>${escapeXml(projName)}</v></c>
            <c r="C${rowNum}" t="str"><v>${escapeXml(row.name)}</v></c>
            <c r="D${rowNum}"><v></v></c>
            <c r="E${rowNum}"><v></v></c>
            <c r="F${rowNum}" t="str"><v></v></c>
            <c r="G${rowNum}" t="str"><v>${row.customerid}</v></c>
            <c r="H${rowNum}" t="str"><v>${row.projectid}</v></c>
            <c r="I${rowNum}" t="str"><v>${row.id}</v></c>
            <c r="J${rowNum}" t="str"><v>${userId}</v></c>
        </row>`;
    })
    .join("");

  for (let i = 2; i <= 8; i++) {
    const sheetXml = await zip
      .file(`xl/worksheets/sheet${i}.xml`)
      .async("string");

    const existingRowsMatch = sheetXml.match(
      /<sheetData>([\s\S]*?)<\/sheetData>/,
    );
    const existingRows = existingRowsMatch ? existingRowsMatch[1] : "";

    const updatedXml = sheetXml.replace(
      /<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/,
      `<sheetData>${existingRows}${dataRows}</sheetData>`,
    );

    zip.file(`xl/worksheets/sheet${i}.xml`, updatedXml);
  }

  // Generate output buffer
  const outputBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return outputBuffer;
}

function escapeXml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/*
 * main handler
 */

export const handler = async (event) => {
  console.log(`Event: ${JSON.stringify(event)}`);
  const eventBody = JSON.parse(event.body);
  let bodyText = "no action set";
  if (eventBody.action === "send") {
    const sppAttachmentRequest = {
      authObj: authObj,
      recordType: "Attachment",
      criteriaObj: {
        id: 17447,
      },
      limit: 1,
    };

    const template = await callSharedUtil(
      "tslib-getRecords",
      sppAttachmentRequest,
    );

    const usersToProcess = await getUsers();
    for (const user of usersToProcess) {
      const email = user.addr.Address.email;
      const userTasks = await getTasks(user.id);
      const outputBuffer = await createSpreadsheet(
        userTasks,
        template.base64_data,
      );

      await sendTimesheetEmail({
        toAddress: "jim@addolution.com",
        attachmentBuffer: outputBuffer,
        fileName: `timesheet.xlsm`,
      });
    }
    bodyText = "send executed";
  } else if (eventBody.action === "receive") {
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

    const writeObjArray = [];
    for (const row of eventBody.rows) {
      const newWriteObj = {
        customerid: row.customerId,
        projectid: row.projectId,
        projecttaskid: row.taskId,
        decimal_hours: row.hours,
        notes: row.notes,
        userid: 36,
        date: row.date,
      };
      writeObjArray.push(newWriteObj);
    }

    const timeEntryWriteRequest = {
      authObj: authObj,
      recordType: "Task",
      writeObj: writeObjArray,
    };

    const timeEntryWriteResponse = await callSharedUtil(
      "tslib-putRecords",
      timeEntryWriteRequest,
    );
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
  const passedEvent = {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: {
      "content-length": "259",
      "x-amzn-tls-version": "TLSv1.3",
      "x-forwarded-proto": "https",
      "accept-language": "en-us",
      "x-forwarded-port": "443",
      "x-forwarded-for": "136.32.176.156",
      accept: "*/*",
      "x-amzn-tls-cipher-suite": "TLS_AES_128_GCM_SHA256",
      "x-amzn-trace-id": "Root=1-6a1865ee-2635f65676ca175309adbdf2",
      "ua-cpu": "AMD64",
      host: "eseisyd2naugpsnb7qntwnoyuq0monkf.lambda-url.us-east-2.on.aws",
      "content-type": "application/json",
      "cache-control": "no-cache",
      "accept-encoding": "gzip, deflate",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Trident/7.0; rv:11.0) like Gecko",
    },
    requestContext: {
      accountId: "anonymous",
      apiId: "eseisyd2naugpsnb7qntwnoyuq0monkf",
      domainName:
        "eseisyd2naugpsnb7qntwnoyuq0monkf.lambda-url.us-east-2.on.aws",
      domainPrefix: "eseisyd2naugpsnb7qntwnoyuq0monkf",
      http: {
        method: "POST",
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "136.32.176.156",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Trident/7.0; rv:11.0) like Gecko",
      },
      requestId: "004d9de6-654f-4f27-9845-a880d02a767b",
      routeKey: "$default",
      stage: "$default",
      time: "28/May/2026:15:57:34 +0000",
      timeEpoch: 1779983854652,
    },
    body: '{"action":"receive","userId":"37","rows":[{"date":"2026-05-28","customerId":"1090","projectId":"1480","taskId":"10424","hours":3,"notes":"because"},{"date":"2026-05-29","customerId":"3093","projectId":"2062","taskId":"15097","hours":4,"notes":"these notes"}]}',
    isBase64Encoded: false,
  };

  const result = await handler(passedEvent);
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
