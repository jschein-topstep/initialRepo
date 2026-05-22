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

  const instanceIdentifier = /^(sb|sandbox)$/i.test(criteria.authObj.instance)
    ? { apiKey: sbKey, suffix: "sb" }
    : { apiKey: prodKey, suffix: "prod" };

  let deletionRecords = Array.isArray(criteria.recordsToDelete)
    ? criteria.recordsToDelete
    : [criteria.recordsToDelete];

  if (criteria.lookupObj) {
    // add record lookup, overwrite deletionRecords
  }

  const xmlDeleteCommands = deletionRecords.map(
    (record) =>
      `<Delete type="${criteria.recordType}"><${criteria.recordType}><id>${typeof record === "object" ? record.id : record}</id></${criteria.recordType}></Delete>`,
  );
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
        ${xmlDeleteCommands.join("")}
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
      company: "top step sandbox",
      user: "jschein",
      password: "Topstep1",
      instance: "sb",
    },
    recordType: "Task",
    recordsToDelete: [
      {
        id: 154544,
      },
      { id: 155817 },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
