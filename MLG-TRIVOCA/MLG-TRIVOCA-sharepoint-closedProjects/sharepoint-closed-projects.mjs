import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({ region: "us-east-2" });
const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
  ? "/opt/nodejs/sharedUtils.js"
  : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);
//may not need spp creds
/*const authObj = {
  company: process.env.COMPANY,
  user: process.env.USER,
  password: process.env.PASSWORD,
  instance: process.env.INSTANCE,
};*/

// Retrieve projects from SPP read (passed via lambda function call)
export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  console.log(`bodyJSON: ${JSON.stringify(bodyJSON)}`);

  if (!Array.isArray(bodyJSON.projects) || bodyJSON.projects.length === 0) {
    console.log("No projects in payload");
    return;
  }
  const token = await getGraphToken();

  await Promise.all(
    bodyJSON.projects.map(async (project) => {
      const ownerId = await getUserId(token, "anthony.flores@trivoca.com");

      if (project.proj_Division__c === "Qual" && project.active != 1) {
        console.log(`QUAL project: ${project.name}`);
        await deleteClientListSubfolder(project, token);
      } else if (project.proj_Division__c === "Quant" && project.active != 1) {
        console.log(`QUANT project: ${project.name}`);
        await deleteClientListSubfolder(project, token);
      } else {
        console.log(`No QUAL or QUANT projects found`);
      }
    }),
  );
};

// Validate the projects retrieved from SPP meet filter criteria (Loop B, first decision)
async function projectFilterValidation(projects) {}

// Delete the client lists subfolder in Sharepoint for each CLOSED project (Loop B, Yes branch, first action)
async function deleteClientListSubfolder(project, token) {
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
  const hostname = "trivocahealth.sharepoint.com";

  const SITE_PATH_BY_DIVISION = {
    Qual: "/sites/QualProjects",
    Quant: "/sites/QuantProjects", // adjust if the actual Quant site path differs
  };

  const sitePath = SITE_PATH_BY_DIVISION[project.proj_Division__c];
  if (!sitePath) {
    console.log(
      `No site path configured for division: ${project.proj_Division__c}`,
    );
    return { deleted: false };
  }

  async function getSiteId(token) {
    const res = await fetch(`${GRAPH_BASE}/sites/${hostname}:${sitePath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(`Failed to resolve site: ${JSON.stringify(data)}`);
    return data.id;
  }
  const siteId = await getSiteId(token);
  console.log(`siteId: ${siteId}`);

  async function getDriveId(token, siteId) {
    const res = await fetch(`${GRAPH_BASE}/sites/${siteId}/drive`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(`Failed to resolve drive: ${JSON.stringify(data)}`);
    return data.id;
  }
  const driveId = await getDriveId(token, siteId);
  console.log(`driveId: ${driveId}`);

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // Find the project's top-level folder by name
  const rootListRes = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/root/children`,
    {
      headers,
    },
  );
  const rootListData = await rootListRes.json();
  if (!rootListRes.ok)
    throw new Error(
      `Failed to list root children: ${JSON.stringify(rootListData)}`,
    );

  const projectFolder = rootListData.value.find(
    (item) => item.folder && item.name === project.name,
  );

  if (!projectFolder) {
    console.log(
      `Project folder "${project.name}" not found in drive ${driveId} — skipping.`,
    );
    return { deleted: false };
  }

  // Find "client lists" within the project folder
  const subListRes = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/items/${projectFolder.id}/children`,
    { headers },
  );
  const subListData = await subListRes.json();
  if (!subListRes.ok)
    throw new Error(
      `Failed to list children of "${project.name}": ${JSON.stringify(subListData)}`,
    );

  const clientListFolder = subListData.value.find(
    (item) => item.folder && item.name === "Client Lists",
  );

  if (!clientListFolder) {
    console.log(
      `"Client Lists" folder not found under "${project.name}" — nothing to delete.`,
    );
    return { deleted: false };
  }

  // Delete it
  const deleteRes = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/items/${clientListFolder.id}`,
    {
      method: "DELETE",
      headers,
    },
  );

  if (deleteRes.status !== 204) {
    const errBody = await deleteRes.text();
    throw new Error(
      `Failed to delete "client lists" for "${project.name}": ${deleteRes.status} ${errBody}`,
    );
  }

  console.log(
    `Deleted "client lists" folder for project "${project.name}" (item ID: ${clientListFolder.id})`,
  );
  return { deleted: true, itemId: clientListFolder.id };
}
async function getGraphToken() {
  const url = `https://login.microsoftonline.com/07df17c1-4112-495c-b15f-76a25f844f3d/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: "82c08c90-bc61-4af4-ad27-7f7e3d838c1c",
    client_secret: "A3H8Q~Wo~wbycVR4j4PDSg6mKtkka.HH26z5.cQF",
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Token request failed: ${JSON.stringify(data)}`);
  } else {
    console.log(`Token request successful: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}
async function getUserId(token, upnOrEmail) {
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(upnOrEmail)}?$select=id,displayName,userPrincipalName`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to resolve user "${upnOrEmail}": ${JSON.stringify(data)}`,
    );
  }

  console.log(`Resolved user: ${data.userPrincipalName} -> id: ${data.id}`);
  return data.id;
}
