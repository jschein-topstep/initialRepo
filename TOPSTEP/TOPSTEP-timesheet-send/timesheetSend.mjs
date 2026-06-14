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
  const normalizedRecords = Array.isArray(userRecords)
    ? userRecords
    : [userRecords];
  return normalizedRecords;
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
    limit: "1000",
    fields: "projecttaskid",
  };

  const assignmentRecords = await callSharedUtil(
    "tslib-getRecords",
    sppAssignmentRequest,
  );

  const taskRecords = [];
  if (assignmentRecords?.length) {
    for (const assignment of assignmentRecords.filter(Boolean)) {
      const sppTaskRequest = {
        authObj: authObj,
        recordType: "Projecttask",
        criteriaObj: {
          id: assignment.projecttaskid,
        },
        limit: 1,
        fields: "id,projectid,customerid,name",
        lookups: [
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
        ],
      };

      const taskRecord = await callSharedUtil(
        "tslib-getRecords",
        sppTaskRequest,
      );
      const normalizedRecord = Array.isArray(taskRecord)
        ? taskRecord[0]
        : taskRecord;
      taskRecords.push(normalizedRecord);
      //await sleep(500);
    }
  }

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

function getNextSunday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  const sunday = new Date(now);
  sunday.setDate(now.getDate() + daysUntilSunday);
  return sunday;
}

function formatSheetDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

function formatISODate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
/*
 * create initial Excel doc
 */

async function createSpreadsheet(taskData, template, userId) {
  const buffer = Buffer.from(template, "base64");
  const zip = await JSZip.loadAsync(buffer);
  const contentTypes = await zip.file("[Content_Types].xml").async("string");
  console.log("Content Types:", contentTypes);

  const sunday = getNextSunday();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    return d;
  });

  // Build unique customers, projects, tasks
  const customers = [];
  const projects = [];
  const tasks = [];
  const seenCustomers = new Set();
  const seenProjects = new Set();

  for (const row of taskData) {
    row.customerName = row.Customer_name;
    row.projectName = row.Project_name;
    if (!seenCustomers.has(row.customerid)) {
      seenCustomers.add(row.customerid);
      customers.push({ name: row.customerName, id: row.customerid });
    }
    if (!seenProjects.has(row.projectid)) {
      seenProjects.add(row.projectid);
      projects.push({
        name: row.projectName,
        id: row.projectid,
        customerId: row.customerid,
      });
    }
    tasks.push({ name: row.name, id: row.id, projectId: row.projectid });
  }

  customers.sort((a, b) => a.name.localeCompare(b.name));
  projects.sort((a, b) => a.name.localeCompare(b.name));
  tasks.sort((a, b) => a.name.localeCompare(b.name));

  // Build Data sheet rows
  const allRows = new Map();

  const addCell = (rowNum, colLetter, value) => {
    if (!allRows.has(rowNum)) allRows.set(rowNum, []);
    allRows
      .get(rowNum)
      .push(
        `<c r="${colLetter}${rowNum}" t="str"><v>${escapeXml(String(value))}</v></c>`,
      );
  };

  // Row 1 headers (optional but helpful)
  addCell(1, "A", "CustomerName");
  addCell(1, "B", "CustomerId");
  addCell(1, "D", "ProjectName");
  addCell(1, "E", "ProjectId");
  addCell(1, "F", "CustomerIdRef");
  addCell(1, "H", "TaskName");
  addCell(1, "I", "TaskId");
  addCell(1, "J", "ProjectIdRef");
  addCell(1, "L", "FilteredProjects");
  addCell(1, "M", "FilteredTasks");

  customers.forEach((c, i) => {
    const r = i + 2;
    addCell(r, "A", c.name);
    addCell(r, "B", c.id);
  });

  projects.forEach((p, i) => {
    const r = i + 2;
    addCell(r, "D", p.name);
    addCell(r, "E", p.id);
    addCell(r, "F", p.customerId);
  });

  tasks.forEach((t, i) => {
    const r = i + 2;
    addCell(r, "H", t.name);
    addCell(r, "I", t.id);
    addCell(r, "J", t.projectId);
  });

  // Build Data sheet XML
  const dataRows = Array.from(allRows.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([r, cells]) => `<row r="${r}">${cells.join("")}</row>`)
    .join("");

  const dataMaxRow = Math.max(
    1,
    customers.length + 1,
    projects.length + 1,
    tasks.length + 1,
  );

  const dataSheetXml = await zip
    .file("xl/worksheets/sheet9.xml")
    .async("string");
  let updatedDataXml = dataSheetXml.replace(
    /(<dimension ref=")[^"]*(")/,
    `$1A1:M${dataMaxRow}$2`,
  );
  updatedDataXml = updatedDataXml.replace(
    /<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/,
    `<sheetData>${dataRows}</sheetData>`,
  );
  zip.file("xl/worksheets/sheet9.xml", updatedDataXml);

  // Rename sheets 2-8
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let workbookXml = await zip.file("xl/workbook.xml").async("string");
  days.forEach((date, i) => {
    const sheetName = `${dayNames[date.getDay()]}, ${formatSheetDate(date)}`;
    workbookXml = workbookXml.replace(
      new RegExp(`name="Sheet${i + 2}"`),
      `name="${sheetName}"`,
    );
  });
  zip.file("xl/workbook.xml", workbookXml);

  // Update each day sheet with userId and named range validations
  for (let i = 0; i < 7; i++) {
    let sheetXml = await zip
      .file(`xl/worksheets/sheet${i + 2}.xml`)
      .async("string");
    sheetXml = sheetXml.replace(/(<dimension ref=")[^"]*(")/, `$1A1:J1000$2`);

    // userId in fixed cell F2
    const existingRowsMatch = sheetXml.match(
      /<sheetData>([\s\S]*?)<\/sheetData>/,
    );
    const existingRows = existingRowsMatch ? existingRowsMatch[1] : "";
    const userIdRow = `<row r="2"><c r="F2" t="str"><v>${escapeXml(String(userId))}</v></c></row>`;

    // Merge the userId row into sheetData while keeping rows in ascending r order
    const rowMap = new Map();
    const existingRowMatches = existingRows.matchAll(
      /<row r="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g,
    );
    for (const match of existingRowMatches) {
      rowMap.set(Number(match[1]), match[0]);
    }
    rowMap.set(2, userIdRow);

    const orderedRows = Array.from(rowMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, rowXml]) => rowXml)
      .join("");

    sheetXml = sheetXml.replace(
      /<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/,
      `<sheetData>${orderedRows}</sheetData>`,
    );

    // Named range validations pointing at Data sheet columns
    const dataValidation = `<dataValidations count="3">
    <dataValidation type="list" sqref="A4:A1000" showDropDown="0" showErrorMessage="1" errorTitle="Invalid Selection" error="Please select a customer from the list.">
        <formula1>Data!$A$2:$A$${customers.length + 1}</formula1>
    </dataValidation>
    <dataValidation type="list" sqref="B4:B1000" showDropDown="0" showErrorMessage="1" errorTitle="Invalid Selection" error="Please select a project from the list.">
        <formula1>Data!$L$2:$L$1000</formula1>
    </dataValidation>
    <dataValidation type="list" sqref="G4:G1000" showDropDown="0" showErrorMessage="1" errorTitle="Invalid Selection" error="Please select a task from the list.">
        <formula1>Data!$M$2:$M$1000</formula1>
    </dataValidation>
</dataValidations>`;

    //const dataValidation = `<dataValidations count="1"><dataValidation type="list" sqref="A5:A1000"><formula1>&quot;test&quot;</formula1></dataValidation></dataValidations>`;

    if (!sheetXml.includes("<dataValidations")) {
      sheetXml = sheetXml.replace(
        "<pageMargins",
        `${dataValidation}<pageMargins`,
      );
    }

    if (i === 0) {
      console.log("Sheet2 XML end:", sheetXml.substring(sheetXml.length - 300));
    }
    /*
    if (i === 0) {
      console.log("Sheet2 XML middle:", sheetXml.substring(500, 1500));

      const hasSheetData =
        /<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/.test(sheetXml);
      console.log("sheetData found:", hasSheetData);
    }*/
    zip.file(`xl/worksheets/sheet${i + 2}.xml`, sheetXml);
  }

  // Update title cell on Sheet1 with the date range covered by Sheet2 - Sheet8
  let sheet1Xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  const titleText = `Timesheet for the week of ${formatISODate(days[0])} through ${formatISODate(days[6])}`;
  sheet1Xml = setCellValue(sheet1Xml, "A1", titleText);
  zip.file("xl/worksheets/sheet1.xml", sheet1Xml);

  const outputBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return outputBuffer;
}

function setCellValue(sheetXml, cellRef, value) {
  const cellRegex = new RegExp(
    `<c r="${cellRef}"((?:\\s+[^>]*?)?)(?:/>|>([\\s\\S]*?)</c>)`,
  );
  return sheetXml.replace(cellRegex, (match, attrs) => {
    const cleanedAttrs = attrs.replace(/\s+t="[^"]*"/, "");
    return `<c r="${cellRef}"${cleanedAttrs} t="str"><v>${escapeXml(String(value))}</v></c>`;
  });
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

    const templateRecords = await callSharedUtil(
      "tslib-getRecords",
      sppAttachmentRequest,
    );
    const template = templateRecords?.[0];

    const usersToProcess = await getUsers();
    for (const user of usersToProcess) {
      const email = user.addr.Address.email;
      const userTasks = await getTasks(user.id);
      const outputBuffer = await createSpreadsheet(
        userTasks,
        template.base64_data,
        75,
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
        userid: 75,
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

async function testSend() {
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
    body: '{"action":"send"}',
    isBase64Encoded: false,
  };
  const result = await handler(passedEvent);
  console.log(JSON.stringify(result, null, 2));
}
async function testReceive() {
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
    body: '{"action":"receive","userId":"","rows":[{"date":"2026-05-31","customerId":"1090","projectId":"1480","taskId":"10424","hours":1,"notes":"abc"},{"date":"2026-05-31","customerId":"3150","projectId":"2166","taskId":"15099","hours":2,"notes":"def"}]}',
    isBase64Encoded: false,
  };

  const result = await handler(passedEvent);
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  testSend();
}
