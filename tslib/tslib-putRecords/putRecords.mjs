import { XMLParser } from "fast-xml-parser";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";

const { callSharedUtil } = await import(sharedPath);

const ssm = new SSMClient({});

async function buildUpsertXml(xmlCriteria, logs) {
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
  let action = "Add";

  for (const key in xmlCriteria.writeObj) {
    if (Object.prototype.hasOwnProperty.call(xmlCriteria.writeObj, key)) {
      if (key === "id") {
        action = "Modify";
      }

      if (typeof xmlCriteria.writeObj[key] === "object") {
        const value = xmlCriteria.writeObj[key].value;
        const lookupBy = xmlCriteria.writeObj[key].lookupBy;
        const inTable = xmlCriteria.writeObj[key].inTable;

        const sppLookupRequest = {
          authObj: xmlCriteria.authObj,
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
        logs.push(`Lookup ID: ${lookupRecord.id}`);

        criteriaXML += `<${key}>${lookupRecord.id}</${key}>`;
      } else {
        if (key === "date") {
          const d = new Date(xmlCriteria.writeObj[key]);
          const pad = (num) => {
            return num.toString().padStart(2, "0");
          };
          const dateStr = `<Date><year>${d.getFullYear()}</year><month>${pad(d.getMonth() + 1)}</month><day>${pad(d.getDate())}</day></Date>`;
          criteriaXML += `<${key}>${dateStr}</${key}>`;
        } else {
          criteriaXML += `<${key}>${xmlCriteria.writeObj[key]}</${key}>`;
        }
      }
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
        <${action} type="${xmlCriteria.recordType}" enable_custom="1">
          <${xmlCriteria.recordType}>
            ${criteriaXML}
          </${xmlCriteria.recordType}>
        </${action}>
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
    logs.push(`sppResponseXML: ${sppResponseXML}`);

    return {
      statusCode: 200,
      logs,
      headers: {
        "Content-Type": "application/json",
      },
      body:
        sppResponseXML.response.Add[event.recordType] ||
        sppResponseXML.response.Modify[event.recordType] ||
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
      company: "top step sandbox",
      user: "jschein",
      password: "Topstep1",
      instance: "sb",
    },
    recordType: "Jobcode",
    writeObj: {
      name: "delete this job code",
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
