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
  for (const key in xmlCriteria.criteriaObj) {
    if (Object.prototype.hasOwnProperty.call(xmlCriteria.criteriaObj, key)) {
      criteriaXML += `<${key}>${xmlCriteria.criteriaObj[key]}</${key}>`;
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

  for (const dataRow of origData) {
    for (const lookupObj of lookups) {
      const idFieldInData = lookupObj.idField;
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
        const lookupRecord = await callSharedUtil(
          "tslib-getRecords",
          sppLookupRequest,
        );
        await sleep(1000);
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

  return origData;
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
    const responseObject = Array.isArray(
      sppResponseXML.response.Read[event.recordType],
    )
      ? sppResponseXML.response.Read[event.recordType]
      : [sppResponseXML.response.Read[event.recordType]];

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

async function test() {
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

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
