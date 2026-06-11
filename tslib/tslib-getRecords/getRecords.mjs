import { XMLParser } from "fast-xml-parser";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js"; // adjust relative path as needed
const { callSharedUtil } = await import(sharedPath);

const oauthPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/oauthUtils.mjs"
  : "../../layer/nodejs/oauthUtils.mjs"; // adjust relative path as needed
const { getValidAccessToken } = await import(oauthPath);

const ssm = new SSMClient({});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildReadXml(xmlCriteria, logs) {
  const sbResponse = await ssm.send(
    new GetParameterCommand({
      Name: "/spp/sandboxKey",
      WithDecryption: true,
    }),
  );
  const sbKey = sbResponse.Parameter.Value;

  const prodResponse = await ssm.send(
    new GetParameterCommand({
      Name: "/spp/productionKey",
      WithDecryption: true,
    }),
  );
  const prodKey = prodResponse.Parameter.Value;

  const instanceIdentifier = /^(sb|sandbox)$/i.test(
    xmlCriteria.authObj.instance,
  )
    ? { apiKey: sbKey, suffix: "sb" }
    : { apiKey: prodKey, suffix: "prod" };

  let criteriaXML = "";
  for (const [key, value] of Object.entries(xmlCriteria.criteriaObj)) {
    if (typeof value === "object") {
      const returnField = value.returnField || "id";
      const sppRequest = {
        authObj: xmlCriteria.authObj,
        recordType: value.inTable,
        criteriaObj: {
          [value.lookupBy]: value.value,
        },
        limit: 1,
        fields: returnField,
      };
      const sppRecords = await callSharedUtil("tslib-getRecords", sppRequest);
      if (sppRecords && sppRecords.length > 0) {
        criteriaXML += `<${key}>${sppRecords[0][returnField]}</${key}>`;
      }
    } else {
      criteriaXML += `<${key}>${value}</${key}>`;
    }
  }

  let fieldsXML = "";
  if (xmlCriteria.fields) {
    fieldsXML = "<_Return>";
    const fieldArray = xmlCriteria.fields.split(",");
    for (const key in fieldArray) {
      fieldsXML += `<${fieldArray[key]}/>`;
    }
    fieldsXML += "</_Return>";
  }

  const accessToken = await getValidAccessToken(
    `spp-${xmlCriteria.authObj.company.toLowerCase()}-${instanceIdentifier.suffix}`,
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${instanceIdentifier.apiKey}">
        <Auth>
          <Login>
                  <access_token>${accessToken}</access_token>
          </Login>
        </Auth>
        <Read type="${xmlCriteria.recordType}" method="equal to" limit="${xmlCriteria.limit}" enable_custom="1">
          <${xmlCriteria.recordType}>
            ${criteriaXML}
          </${xmlCriteria.recordType}>${fieldsXML}
        </Read>
      </request>`;
}

async function addLookups(event, origData, logs) {
  const valueStore = [];
  const lookups = event.lookups;

  const data = Array.isArray(origData) ? origData : [origData];

  for (const dataRow of data) {
    for (const lookupObj of lookups) {
      const idFieldInData = lookupObj.idFieldInData;
      const returnField = lookupObj.returnField;
      const inTable = lookupObj.inTable;

      let returnedValue;
      const foundStoredObject = valueStore.find(
        (storedObject) =>
          storedObject.inTable == inTable &&
          storedObject.returnField == returnField &&
          storedObject.idFieldInData == idFieldInData &&
          storedObject.idValue == dataRow[idFieldInData],
      );

      if (foundStoredObject) {
        dataRow[`${inTable}.${returnField}`] = foundStoredObject.returnedValue;
      } else {
        const sppLookupRequest = {
          authObj: event.authObj,
          recordType: inTable,
          criteriaObj: {
            id: dataRow[`${idFieldInData}`],
          },
          limit: 1,
        };
        let lookupResult;
        try {
          lookupResult = await callSharedUtil(
            "tslib-getRecords",
            sppLookupRequest,
          );
        } catch (err) {
          logs.push(`Full error: ${JSON.stringify(err)}`);
          console.error(err);
        }
        await sleep(100);
        const lookupRecord = lookupResult?.[0];
        if (lookupRecord?.id) {
          //logs.push(`Lookup ID: ${lookupRecord.id}`);
          dataRow[`${inTable}_${returnField}`] = lookupRecord[`${returnField}`];
          valueStore.push({
            inTable: inTable,
            returnField: returnField,
            idFieldInData: idFieldInData,
            returnedValue: lookupRecord[`${returnField}`],
            idValue: dataRow[idFieldInData],
          });
        } else {
          logs.push(`Nothing returned for lookup request`);
        }
      }
    }
  }

  return data;
}

export const handler = async (event) => {
  const logs = [];
  const parser = new XMLParser();

  try {
    logs.push(`event: ${JSON.stringify(event)}`);

    const sbUrlResponse = await ssm.send(
      new GetParameterCommand({
        Name: "/spp/sandboxXMLURL",
        WithDecryption: true,
      }),
    );
    const sbUrl = sbUrlResponse.Parameter.Value;

    const prodUrlResponse = await ssm.send(
      new GetParameterCommand({
        Name: "/spp/productionXMLURL",
        WithDecryption: true,
      }),
    );
    const prodUrl = prodUrlResponse.Parameter.Value;

    const xml = await buildReadXml(event, logs);
    logs.push(`xml: ${xml}`);

    const sppUrl = /^(sb|sandbox)$/i.test(event.authObj.instance)
      ? sbUrl
      : prodUrl;

    logs.push(`sppUrl: ${sppUrl}`);

    const response = await fetch(sppUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
      },
      body: xml,
    });

    const responseText = await response.text();

    if (!response.ok) {
      logs.push(`SPP error response: ${responseText}`);
      return {
        statusCode: response.status,
        logs,
        body: {
          error: "SPP request failed",
          status: response.status,
          response: responseText,
        },
      };
    }

    //logs.push(`SPP response: ${responseText}`);
    const sppResponseXML = parser.parse(responseText);
    const rawResponseObject = sppResponseXML.response.Read[event.recordType];
    const responseObject =
      rawResponseObject === undefined
        ? []
        : Array.isArray(rawResponseObject)
          ? rawResponseObject
          : [rawResponseObject];

    const endResult = event.lookups
      ? await addLookups(event, responseObject, logs)
      : responseObject;
    return {
      statusCode: 200,
      logs,
      body: endResult,
    };
  } catch (err) {
    logs.push(`ERROR: ${err.message}`);
    return {
      statusCode: 500,
      logs,
      body: { error: err.message },
    };
  }
};

// ── Local testing only ──────────────────────────────────────────────────────

async function test0() {
  const result = await handler({
    authObj: {
      company: "Tempus Sandbox",
      instance: "sandbox",
    },
    recordType: "Projecttask",
    criteriaObj: {
      id: 6,
    },
    limit: 1,
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
  });
  console.log(JSON.stringify(result, null, 2));
}

async function test1() {
  const result = await handler({
    authObj: {
      company: "Tempus Sandbox",
      instance: "sandbox",
    },
    recordType: "Projecttaskassign",
    criteriaObj: {
      projecttaskid: 2881,
      userid: {
        value: "Sr. Data Manager",
        lookupBy: "name",
        inTable: "User",
      },
    },
    limit: 1,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test1();
}
