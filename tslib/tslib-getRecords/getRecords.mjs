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

  const apiKey = /^(sb|sandbox)$/i.test(xmlCriteria.authObj.instance)
    ? sbKey
    : prodKey;

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

  const accessToken = await getValidAccessToken("spp-TEMPUS-sb");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${apiKey}">
        <Auth>
          <Login>
                  <company>${xmlCriteria.authObj.company}</company>
                  <user>${xmlCriteria.authObj.user}</user>
                  <password>${xmlCriteria.authObj.password}</password>
          </Login>
        </Auth>
        <Read type="${xmlCriteria.recordType}" method="equal to" limit="${xmlCriteria.limit}" enable_custom="1">
          <${xmlCriteria.recordType}>
            ${criteriaXML}
          </${xmlCriteria.recordType}>${fieldsXML}
        </Read>
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
    //logs.push(`ID: ${sppResponseXML.response.Read[event.recordType].id}`);

    return {
      statusCode: 200,
      logs,
      body: sppResponseXML.response.Read[event.recordType],
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
      company: "top step",
      user: "jschein",
      password: "Topstep1",
      instance: "production",
    },
    recordType: "Project",
    criteriaObj: {
      id: 4,
    },
    limit: 1,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
