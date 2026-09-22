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

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SHAREPOINT_HOSTNAME = "trivocahealth.sharepoint.com";
const SITE_PATH_BY_DIVISION = {
  Qual: "/sites/QualitativeProjects",
  Quant: "/sites/QuantitativeProjects", // adjust if the actual Quant site path differs
};

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
      console.log(`Inactivation date: ${project.proj_inactivation_date__c}`);

      if (project.proj_inactivation_date__c != "0000-00-00") {
        const ninetyDayMilliseconds = 90 * 24 * 60 * 60 * 1000;
        const inactivationDate = new Date(project.proj_inactivation_date__c);
        const now = new Date();
        console.log(`ninetyDayMilliseconds: ${ninetyDayMilliseconds}`);
        console.log(`now: ${now}`);

        if (now - inactivationDate > ninetyDayMilliseconds) {
          console.log(
            `Project "${project.name}" is inactive for more than 90 days — proceeding with closure.`,
          );

          if (project.proj_Division__c === "Qual" && project.active != 1) {
            console.log(`QUAL project: ${project.name}`);
            await deleteClientListSubfolder(project, token);
          } else if (
            project.proj_Division__c === "Quant" &&
            project.active != 1
          ) {
            console.log(`QUANT project: ${project.name}`);
            await deleteClientListSubfolder(project, token);
          } else {
            console.log(`No QUAL or QUANT projects found`);
          }

          if (project.proj_sharepoint_team_id__c) {
            await archiveSharepointTeam(
              token,
              project.proj_sharepoint_team_id__c,
              project.name,
            );
          } else {
            console.log(
              `No proj_sharepoint_team_id__c on project "${project.name}" — skipping Team archive.`,
            );
          }
        }
      }
    }),
  );
};

// Validate the projects retrieved from SPP meet filter criteria (Loop B, first decision)
async function projectFilterValidation(projects) {}

// Delete the client lists subfolder in Sharepoint for each CLOSED project (Loop B, Yes branch, first action).
// Resolves the parent project folder directly by its stored SharePoint item ID
// (project.proj_sharepoint_folder_id__c) rather than looking it up by name.
async function deleteClientListSubfolder(project, token) {
  const sitePath = SITE_PATH_BY_DIVISION[project.proj_Division__c];
  console.log(`sitePath: ${sitePath}`);
  if (!sitePath) {
    console.log(
      `No site path configured for division: ${project.proj_Division__c}`,
    );
    return { deleted: false };
  }

  async function getSiteId(token) {
    const res = await fetch(
      `${GRAPH_BASE}/sites/${SHAREPOINT_HOSTNAME}:${sitePath}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
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

  const folderId = project.proj_sharepoint_folder_id__c;
  if (!folderId) {
    console.log(
      `No proj_sharepoint_folder_id__c on project "${project.name}" — skipping.`,
    );
    return { deleted: false, reason: "missing-folder-id" };
  }

  // Confirm the folder still exists before trying to list its children —
  // a direct-by-id GET distinguishes "already deleted" (404) from a real
  // API error, same as the old name-based lookup did.
  const folderRes = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/items/${folderId}`,
    { headers },
  );
  console.log(`direct folder lookup status: ${folderRes.status}`);
  if (folderRes.status === 404) {
    console.log(
      `Project folder id "${folderId}" not found for "${project.name}" — skipping.`,
    );
    return { deleted: false };
  }
  const projectFolder = await folderRes.json();
  if (!folderRes.ok)
    throw new Error(
      `Failed to resolve folder id "${folderId}" for "${project.name}": ${JSON.stringify(projectFolder)}`,
    );

  // Find "Client Lists" within the project folder
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
    { method: "DELETE", headers },
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

// Archives the SharePoint Team whose id is stored on the project record
// (project.proj_sharepoint_team_id__c). Skips cleanly if the team is missing
// or already archived, so re-running this Lambda against the same project
// after a successful archive is a safe no-op rather than an error.
async function archiveSharepointTeam(token, teamId, projectName) {
  const headers = { Authorization: `Bearer ${token}` };

  const teamRes = await fetch(`${GRAPH_BASE}/teams/${teamId}`, { headers });
  if (teamRes.status === 404) {
    console.log(
      `Team "${teamId}" for "${projectName}" not found — may already be deleted, skipping archive.`,
    );
    return { archived: false, reason: "team-not-found" };
  }
  const teamData = await teamRes.json();
  if (!teamRes.ok) {
    throw new Error(
      `Failed to resolve team "${teamId}" for "${projectName}": ${JSON.stringify(teamData)}`,
    );
  }
  if (teamData.isArchived) {
    console.log(
      `Team "${teamId}" for "${projectName}" is already archived — skipping.`,
    );
    return { archived: false, reason: "already-archived" };
  }

  const archiveRes = await fetch(`${GRAPH_BASE}/teams/${teamId}/archive`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // shouldSetSpoSiteReadOnlyForMembers isn't supported in the application
    // (app-only) context this Lambda runs in, so it's omitted here rather
    // than set to true.
    body: JSON.stringify({}),
  });

  if (archiveRes.status !== 202) {
    const data = await archiveRes.json().catch(() => ({}));
    throw new Error(
      `Team archive request failed for "${teamId}" (${projectName}): ${JSON.stringify(data)}`,
    );
  }

  const operationUrl = archiveRes.headers.get("Location");
  console.log(
    `Team archive started for "${teamId}" (${projectName}), polling: ${operationUrl}`,
  );
  await pollTeamOperation(token, operationUrl);

  console.log(`Team "${teamId}" archived for "${projectName}".`);
  return { archived: true };
}

// Generic poller for async Team operations (creation, archive, etc.) that
// return a 202 + Location header. Reused across those flows.
async function pollTeamOperation(
  token,
  operationUrl,
  maxAttempts = 30,
  delayMs = 5000,
) {
  let lastStatus = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${GRAPH_BASE}${operationUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    lastStatus = data.status;
    console.log(`Poll attempt ${attempt}: status = ${data.status}`);

    if (data.status === "succeeded") {
      return data;
    }
    if (data.status === "failed") {
      throw new Error(`Team operation failed: ${JSON.stringify(data)}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error(
    `Team operation timed out after ${maxAttempts} attempts for operation: ${operationUrl}. Last known status: "${lastStatus}"`,
  );
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
  const res = await fetch(
    `${GRAPH_BASE}/users/${encodeURIComponent(upnOrEmail)}?$select=id,displayName,userPrincipalName`,
    { headers: { Authorization: `Bearer ${token}` } },
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
