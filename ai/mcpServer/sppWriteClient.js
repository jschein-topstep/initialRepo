// The XML API transport for AI-initiated SPP writes. Deliberately new code,
// NOT a reuse of tslib/tslib-putRecords or tslib/tslib-deleteRecords -- those
// Lambdas serve other, unrelated production automations (invoicing,
// timesheet-send) on a company-level service-account token, and are left
// untouched to avoid any risk to their existing consumers. This module
// reuses their CONFIRMED-WORKING XML envelope shape, but authenticates as
// the calling person's own per-user SPP access token instead (see
// sppUserAuth.js's getSppAccessTokenForUser) -- see the write-feature design
// discussion for why that distinction matters for role enforcement.

const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { LambdaClient, InvokeCommand } = require("@aws-sdk/client-lambda");
const { XMLParser } = require("fast-xml-parser");

const ssm = new SSMClient({});
const lambdaClient = new LambdaClient({});

// Small, hardcoded, GLOBAL (not per-company) platform-capability
// EXCEPTIONS -- a table SPP's own API restricts regardless of role, a
// platform constraint rather than something that varies by customer, so
// hardcoded here rather than curated per-company in report_config.json.
// Every table defaults to fully permitted (create/update/delete); an entry
// here overrides just the actions it explicitly sets to false. Confirmed
// with the user (2026-09-27): revenueRecognitionTransactions is the only
// known exception so far -- SPP's API doesn't expose a delete for that
// record type at all (modify is fine). Add further exceptions here as
// they're discovered; this is expected to stay a short list.
const GLOBAL_WRITE_RESTRICTIONS = {
  revenueRecognitionTransactions: { delete: false },
};

function isGloballyPermitted(table, action) {
  const restriction = GLOBAL_WRITE_RESTRICTIONS[table];
  return restriction?.[action] !== false;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// SPP's compound date field shape, confirmed working in
// tslib-putRecords.mjs's own date-handling block -- expects our fields'
// values as plain "YYYY-MM-DD" strings (matching how they come back out of
// execute_spp_query already).
function dateFieldXml(sppField, isoDateStr) {
  const [year, month, day] = String(isoDateStr).split("-");
  return `<${sppField}><Date><year>${escapeXml(year)}</year><month>${pad2(Number(month))}</month><day>${pad2(Number(day))}</day></Date></${sppField}>`;
}

function plainFieldXml(sppField, value) {
  return `<${sppField}>${escapeXml(value)}</${sppField}>`;
}

// Translates the caller's internal snake_case field names into SPP's own
// XML field names via csvFieldToSppField (from masterConfig.js), wrapping
// date-typed fields per dateColumns. Throws on any field name not present
// in that mapping -- silently dropping an unrecognized field would risk a
// write that looks complete but is silently missing data SPP never saw;
// the caller should have already validated against known fields before
// reaching here, so this is a last-resort safety net, not the primary check.
function buildFieldsXml(fields, csvFieldToSppField, dateColumns) {
  const dateSet = new Set(dateColumns);
  let xml = "";
  for (const [csvField, value] of Object.entries(fields)) {
    const sppField = csvFieldToSppField[csvField];
    if (!sppField) {
      throw new Error(`"${csvField}" is not a known field for this table.`);
    }
    xml += dateSet.has(csvField)
      ? dateFieldXml(sppField, value)
      : plainFieldXml(sppField, value);
  }
  return xml;
}

function wrapEnvelope(apiKey, accessToken, actionXml) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${escapeXml(apiKey)}">
  <Auth>
    <Login>
      <access_token>${escapeXml(accessToken)}</access_token>
    </Login>
  </Auth>
  ${actionXml}
</request>`;
}

function buildAddXml({ apiKey, accessToken, sppType, fields, csvFieldToSppField, dateColumns }) {
  const fieldsXml = buildFieldsXml(fields, csvFieldToSppField, dateColumns);
  const action = `<Add type="${sppType}" enable_custom="1"><${sppType}>${fieldsXml}</${sppType}></Add>`;
  return wrapEnvelope(apiKey, accessToken, action);
}

function buildModifyXml({ apiKey, accessToken, sppType, recordId, fields, csvFieldToSppField, dateColumns }) {
  const fieldsXml = `<id>${escapeXml(recordId)}</id>${buildFieldsXml(fields, csvFieldToSppField, dateColumns)}`;
  const action = `<Modify type="${sppType}" enable_custom="1"><${sppType}>${fieldsXml}</${sppType}></Modify>`;
  return wrapEnvelope(apiKey, accessToken, action);
}

function buildDeleteXml({ apiKey, accessToken, sppType, recordId }) {
  const action = `<Delete type="${sppType}"><${sppType}><id>${escapeXml(recordId)}</id></${sppType}></Delete>`;
  return wrapEnvelope(apiKey, accessToken, action);
}

class SppWriteRejectedError extends Error {
  constructor(message, rawResponse) {
    super(message);
    this.name = "SppWriteRejectedError";
    this.rawResponse = rawResponse;
  }
}

// Sends the built XML request and returns SPP's parsed response node on
// success. IMPORTANT, unverified from any code read while designing this
// (neither tslib-putRecords.mjs nor tslib-deleteRecords.mjs handle it --
// they only ever exercised the HTTP-failure and well-formed-success paths):
// the exact shape of a 200-status response where the WRITE ITSELF was
// rejected server-side (a role-permission denial, a validation error) is
// unknown. This function is deliberately conservative -- anything that
// isn't a recognizable success shape is treated as a rejection rather than
// assumed to be success -- but the rejection-detection logic here MUST be
// confirmed against a real SPP response (see the write-feature rollout
// plan's step 5, a manual scripted test against the demo account) before
// being trusted in production. Do not treat this as settled behavior.
async function sendXmlRequest(xmlUrl, xml) {
  const response = await fetch(xmlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xml,
  });
  const text = await response.text();

  if (!response.ok) {
    throw new SppWriteRejectedError(`SPP request failed [${response.status}]: ${text}`, text);
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  let parsed;
  try {
    parsed = parser.parse(text);
  } catch (error) {
    throw new SppWriteRejectedError(`Could not parse SPP's response: ${error.message}`, text);
  }

  const responseNode = parsed?.response;
  if (!responseNode) {
    throw new SppWriteRejectedError(`Unexpected SPP response shape: ${text}`, text);
  }
  return responseNode;
}

let cachedCredentials = null;

// Company-level XML API key + endpoint URL (distinct from the caller's own
// per-user OAuth access token above) -- same SSM naming convention
// sppDataSync.js already established: ${SSM_PARAM_PREFIX}/${instance}Key
// and .../${instance}XMLURL. Cached per warm container; these only change
// via a deploy-time config change.
async function getSppCredentials(instance) {
  if (cachedCredentials) return cachedCredentials;

  const prefix = process.env.SSM_PARAM_PREFIX;
  if (!prefix) {
    throw new Error("SSM_PARAM_PREFIX environment variable is not set on this Lambda");
  }

  const [apiKeyResult, xmlUrlResult] = await Promise.all([
    ssm.send(new GetParameterCommand({ Name: `${prefix}/${instance}Key`, WithDecryption: true })),
    ssm.send(new GetParameterCommand({ Name: `${prefix}/${instance}XMLURL`, WithDecryption: true })),
  ]);

  cachedCredentials = {
    apiKey: apiKeyResult.Parameter.Value,
    xmlUrl: xmlUrlResult.Parameter.Value,
  };
  return cachedCredentials;
}

// Fire-and-forget: asks sppDataSync to re-pull just this one table sooner
// than its next scheduled cycle, using the company-level sync credential
// (NOT the caller's own token -- decoupling "who wrote this" from "which
// credential re-confirms it" was a deliberate design choice). Never awaited
// to completion and never throws past this function -- a failure here must
// not fail the write response the user is waiting on; the existing 5-minute
// staleness check in reportEngine.js will pick up the change regardless,
// just later, once the scheduled sync eventually runs.
async function triggerResync(localTable) {
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.SPP_DATA_SYNC_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            integrationKey: process.env.SPP_SYNC_INTEGRATION_KEY,
            instance: process.env.SPP_INSTANCE,
            company: process.env.SPP_INSTANCE_NAME,
            table: localTable,
          }),
        ),
      }),
    );
  } catch (error) {
    console.log(`Failed to trigger post-write resync for "${localTable}": ${error.message}`);
  }
}

module.exports = {
  isGloballyPermitted,
  buildAddXml,
  buildModifyXml,
  buildDeleteXml,
  sendXmlRequest,
  SppWriteRejectedError,
  getSppCredentials,
  triggerResync,
};
