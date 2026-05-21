import { XMLParser } from "fast-xml-parser";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);
const ssm = new SSMClient({});

async function buildDeleteXml(xmlCriteria, logs) {
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

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${apiKey}">
        <Auth>
          <Login>
                  <company>${xmlCriteria.authObj.company}</company>
                  <user>${xmlCriteria.authObj.user}</user>
                  <password>${xmlCriteria.authObj.password}</password>
          </Login>
        </Auth>
        <Delete type="${xmlCriteria.recordType}">
          <${xmlCriteria.recordType}>
            ${criteriaXML}
          </${xmlCriteria.recordType}>${fieldsXML}
        </Delete>
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
