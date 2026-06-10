import { XMLParser } from "fast-xml-parser";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);
const oauthPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/oauthUtils.mjs"
  : "../../layer/nodejs/oauthUtils.mjs"; // adjust relative path as needed
const { getValidAccessToken } = await import(oauthPath);
const ssm = new SSMClient({});

async function buildDeleteXml(criteria, logs) {
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
  let xmlDeleteCommands = "";
  const instanceIdentifier = /^(sb|sandbox)$/i.test(criteria.authObj.instance)
    ? { apiKey: sbKey, suffix: "sb" }
    : { apiKey: prodKey, suffix: "prod" };

  let deletionRecords = Array.isArray(criteria.recordsToDelete)
    ? criteria.recordsToDelete
    : [criteria.recordsToDelete];

  for (const delRecord of deletionRecords) {
    if (typeof delRecord !== "object" || delRecord === null) {
      xmlDeleteCommands += `<Delete type="${criteria.recordType}"><${criteria.recordType}><id>${delRecord}</id></${criteria.recordType}></Delete>`;
    } else if (delRecord.id != null && delRecord.id !== "") {
      xmlDeleteCommands += `<Delete type="${criteria.recordType}"><${criteria.recordType}><id>${delRecord.id}</id></${criteria.recordType}></Delete>`;
    } else {
      for (const [key, value] of Object.entries(delRecord)) {
        if (typeof value === "object") {
          // example: {value: "value", lookupBy: "lookupBy Field", inTable: "table"}
          // UNFINISHED - DO NOT USE
          const inTable = value.inTable;
          const fieldValue = value.value;
          const lookupBy = value.lookupBy;

          const recordRequest = {
            authObj: criteria.authObj,
            recordType: inTable,
            criteriaObj: {
              [lookupBy]: value,
            },
            limit: 1000,
          };
        } else {
          // example: {projecttaskid: 287}
          const recordRequest = {
            authObj: criteria.authObj,
            recordType: criteria.recordType,
            criteriaObj: {
              [key]: value,
            },
            limit: 1000,
          };
          const lookupRecords = await callSharedUtil(
            "tslib-getRecords",
            recordRequest,
          );

          for (const lookupRecord of lookupRecords) {
            if (lookupRecord?.id) {
              xmlDeleteCommands += `<Delete type="${criteria.recordType}"><${criteria.recordType}><id>${lookupRecord.id}</id></${criteria.recordType}></Delete>`;
            }
          }
        }
      }
    }
  }

  const accessToken = await getValidAccessToken(
    `spp-${criteria.authObj.company.toLowerCase()}-${instanceIdentifier.suffix}`,
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${instanceIdentifier.apiKey}">
        <Auth>
          <Login>
                  <access_token>${accessToken}</access_token>
          </Login>
        </Auth>
        ${xmlDeleteCommands}
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

    const xml = await buildDeleteXml(event, logs);
    logs.push(`xml: ${xml}`);

    const sppUrl = /^(sb|sandbox)$/i.test(event.authObj.instance)
      ? sbUrl
      : prodUrl;

    //console.log("sppUrl: ", sppUrl);
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

    //console.log("SPP response:", responseText);
    const sppResponseXML = parser.parse(responseText); // returns JSON from the XML

    return {
      statusCode: 200,
      logs,
      headers: {
        "Content-Type": "application/json",
      },
      body: sppResponseXML.response.Delete,
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
      password: "Spring2026$!",
      instance: "sb",
    },
    recordType: "Projecttaskassign",
    recordsToDelete: [
      {
        projecttaskid: 2725,
      },
      {
        projecttaskid: 2726,
      },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
