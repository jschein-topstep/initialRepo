import { XMLParser } from "fast-xml-parser";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);

const ssm = new SSMClient({});

async function buildUpsertXml(criteria, logs) {
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

  const apiKey = /^(sb|sandbox)$/i.test(criteria.authObj.instance)
    ? sbKey
    : prodKey;

  let completeXML = "";

  // turns a single object into an array of one object
  const writeObjs = Array.isArray(criteria.writeObj)
    ? criteria.writeObj
    : [criteria.writeObj];

  for (const writeObj of writeObjs) {
    let criteriaXML = "";
    let action = "Add";

    for (const key in writeObj) {
      if (Object.prototype.hasOwnProperty.call(writeObj, key)) {
        if (key === "id") {
          action = "Modify";
        }

        if (typeof writeObj[key] === "object") {
          const value = writeObj[key].value;
          const lookupBy = writeObj[key].lookupBy;
          const inTable = writeObj[key].inTable;

          if (lookupBy === "externalid") {
            criteriaXML += `<${key} external="${inTable}">${value}</${key}>`;
          } else {
            const sppLookupRequest = {
              authObj: criteria.authObj,
              recordType: inTable,
              criteriaObj: {
                [lookupBy]: value,
              },
              limit: 1,
            };
            const lookupRecord = await callSharedUtil(
              "tslib-getRecords",
              sppLookupRequest,
            );

            if (lookupRecord?.id) {
              logs.push(`Lookup ID: ${lookupRecord.id}`);
              criteriaXML += `<${key}>${lookupRecord.id}</${key}>`;
            } else {
              logs.push(`Nothing returned for lookup request`);
            }
          }
        } else {
          if (key === "date") {
            const d = new Date(writeObj[key]);
            const pad = (num) => {
              return num.toString().padStart(2, "0");
            };
            const dateStr = `<Date><year>${d.getFullYear()}</year><month>${pad(d.getMonth() + 1)}</month><day>${pad(d.getDate())}</day></Date>`;
            criteriaXML += `<${key}>${dateStr}</${key}>`;
          } else {
            criteriaXML += `<${key}>${writeObj[key]}</${key}>`;
          }
        }
      }
    }
    completeXML += `<${action} type="${criteria.recordType}" enable_custom="1"><${criteria.recordType}>${criteriaXML}</${criteria.recordType}></${action}>`;
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${apiKey}">
        <Auth>
          <Login>
                  <company>${criteria.authObj.company}</company>
                  <user>${criteria.authObj.user}</user>
                  <password>${criteria.authObj.password}</password>
          </Login>
        </Auth>
          ${completeXML}
      </request>`;
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

    const rawxml = await buildUpsertXml(event, logs);
    const xml = rawxml.replace(/&/g, "&amp;");
    logs.push(`xml: ${xml}`);

    const sppUrl = /^(sb|sandbox)$/i.test(event.authObj.instance)
      ? sbUrl
      : prodUrl;

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
        body: JSON.stringify({
          error: "SPP request failed",
          status: response.status,
          response: responseText,
        }),
      };
    }

    const sppResponseXML = parser.parse(responseText); // returns JSON from the XML
    console.log(`sppResponseXML: ${JSON.stringify(sppResponseXML)}`);

    return {
      statusCode: 200,
      logs,
      headers: {
        "Content-Type": "application/json",
      },
      body:
        sppResponseXML.response.Add?.[event.recordType] ||
        sppResponseXML.response.Modify?.[event.recordType] ||
        {},
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

async function test() {
  const result = await handler({
    authObj: {
      company: "Tempus Sandbox",
      user: "ronn.breaux@tempus.com",
      instance: "SB",
      password: "Spring2026$!",
    },
    recordType: "Projecttask",
    writeObj: [
      {
        projectid: 176,
        name: "RegOps Management & Oversight Through Last Site Activated",
        parentid: {
          value: "proj176_phase0",
          lookupBy: "externalid",
          inTable: "Projecttask",
        },
        service: {
          value: "4700 - HLS revenue",
          lookupBy: "name",
          inTable: "Category",
        },
        id_number: "1.02",
        unit_basis__c: "month",
        number_units__c: "13",
        externalid: "proj176_task0",
      },

      {
        projectid: 176,
        name: "RegOps Management & Oversight: Enrollment Period Once All Sites Active",
        parentid: {
          value: "proj176_phase0",
          lookupBy: "externalid",
          inTable: "Projecttask",
        },
        id_number: "1.03",
        externalid: "proj176_task1",
      },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
