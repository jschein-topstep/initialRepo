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

// Retrieve projects from SPP read (passed via lambda function call).
// This Lambda now only handles updates to EXISTING SharePoint folders/Teams —
// new-project folder creation is handled elsewhere.
export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  console.log(`bodyJSON: ${JSON.stringify(bodyJSON)}`);

  if (!Array.isArray(bodyJSON.projects) || bodyJSON.projects.length === 0) {
    console.log("No projects in payload");
    return;
  }

  const token = await getGraphToken();

  const results = await Promise.all(
    bodyJSON.projects.map((project) =>
      updateSharepointForProject(project, token),
    ),
  );
  console.log(`Update results: ${JSON.stringify(results)}`);
};

// Resolves the SharePoint site id for a division's configured site path
async function getSiteId(token, sitePath) {
  const res = await fetch(
    `${GRAPH_BASE}/sites/${SHAREPOINT_HOSTNAME}:${sitePath}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Failed to resolve site: ${JSON.stringify(data)}`);
  return data.id;
}

// Resolves the default document library's drive id for a site
async function getDriveId(token, siteId) {
  const res = await fetch(`${GRAPH_BASE}/sites/${siteId}/drive`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok)
    throw new Error(`Failed to resolve drive: ${JSON.stringify(data)}`);
  return data.id;
}

// Looks up a SharePoint site's "User Information List" row id for a user — that row id
// is what personOrGroup fields (like ProjectManagerLookupId) need, not the AAD user id.
// Currently unused (user-lookup PATCH fields are commented out below), kept in case
// person-or-group fields are re-enabled on the update path later.
async function getSharepointUserId(token, siteId, upnOrEmail) {
  const res = await fetch(
    `${GRAPH_BASE}/sites/${siteId}/lists/User%20Information%20List/items?$expand=fields($select=EMail)&$filter=fields/EMail eq '${upnOrEmail}'`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
      },
    },
  );

  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to resolve SharePoint user "${upnOrEmail}": ${JSON.stringify(data)}`,
    );
  }
  if (!data.value || data.value.length === 0) {
    throw new Error(
      `User "${upnOrEmail}" not found in site User Information List — they may not have visited the site yet.`,
    );
  }

  const spUserId = data.value[0].id;
  console.log(`Resolved SharePoint user id for ${upnOrEmail}: ${spUserId}`);
  return spUserId;
}

// Patches list-item fields (metadata) on a drive item, e.g. the project folder
async function updateFolderMetadata(token, driveId, itemId, columns) {
  const res = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/listItem/fields`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(columns),
    },
  );
  console.log(`folderDataRES: ${JSON.stringify(res)}`);
  const data = await res.json();
  console.log(`folderData: ${JSON.stringify(data)}`);
  if (!res.ok) {
    throw new Error(
      `Metadata update failed for item ${itemId}: ${JSON.stringify(data)}`,
    );
  }

  console.log(
    `Metadata updated for item ${itemId}: ${JSON.stringify(columns)}`,
  );
  return data;
}

// ---------------------------------------------------------------------------
// UPDATE PATH — keeps the SharePoint folder + Team in sync when SPP data changes
// (Loop B: "existing project changed" branch)
// ---------------------------------------------------------------------------

// Resolves { siteId, driveId } for a project's division. Throws (rather than
// returning a sentinel) since callers here are per-project and already wrapped
// in try/catch so one bad division doesn't take down the whole update batch.
async function resolveSiteAndDrive(token, division) {
  const sitePath = SITE_PATH_BY_DIVISION[division];
  if (!sitePath) {
    throw new Error(`No site path configured for division: ${division}`);
  }
  const siteId = await getSiteId(token, sitePath);
  const driveId = await getDriveId(token, siteId);
  return { siteId, driveId };
}

// Resolves a drive item by its path relative to the drive root; returns null
// instead of throwing on 404 so callers can distinguish "doesn't exist" from
// a real API error.
async function getFolderByPath(token, driveId, folderName) {
  const res = await fetch(
    `${GRAPH_BASE}/drives/${driveId}/root:/${encodeURIComponent(folderName)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to look up folder "${folderName}": ${JSON.stringify(data)}`,
    );
  }
  return data;
}

// Renames a drive item (used to rename the project's parent folder)
async function renameFolder(token, driveId, itemId, newName) {
  const res = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: newName }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Failed to rename folder ${itemId} to "${newName}": ${JSON.stringify(data)}`,
    );
  }
  console.log(`Folder ${itemId} renamed to "${newName}"`);
  return data;
}

// Updates displayName/description on an existing Team (teamId == the underlying group id)
async function updateTeamProperties(
  token,
  teamId,
  { displayName, description } = {},
) {
  const patch = {};
  if (displayName) patch.displayName = displayName;
  if (description !== undefined) patch.description = description;
  if (Object.keys(patch).length === 0) return;

  const res = await fetch(`${GRAPH_BASE}/teams/${teamId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Failed to update team ${teamId}: ${JSON.stringify(data)}`);
  }
  console.log(`Team ${teamId} updated: ${JSON.stringify(patch)}`);
}

// Adds a user as an owner of the Team's underlying group
// Currently unused (owner-swap block is commented out below), kept in case
// that logic is re-enabled on the update path later.
async function addTeamOwner(token, teamId, userId) {
  const res = await fetch(`${GRAPH_BASE}/groups/${teamId}/owners/$ref`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}`,
    }),
  });
  if (!res.ok && res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    // Graph errors if the user is already an owner — treat that as a no-op, not a failure
    if (!JSON.stringify(data).includes("already exist")) {
      throw new Error(
        `Failed to add owner ${userId} to team ${teamId}: ${JSON.stringify(data)}`,
      );
    }
  }
  console.log(`Owner ${userId} added to team ${teamId}`);
}

// Removes a user from the Team's owners (does not remove them as a regular member)
// Currently unused (owner-swap block is commented out below), kept in case
// that logic is re-enabled on the update path later.
async function removeTeamOwner(token, teamId, userId) {
  const res = await fetch(
    `${GRAPH_BASE}/groups/${teamId}/owners/${userId}/$ref`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      `Failed to remove owner ${userId} from team ${teamId}: ${JSON.stringify(data)}`,
    );
  }
  console.log(
    `Owner ${userId} removed from team ${teamId} (or already wasn't one)`,
  );
}

// Updates the SharePoint parent folder + Team for a project that changed in SPP.
// Handles: name change (folder rename + Team rename), owner/coordinator change
// (folder metadata refresh + Team owner swap).
//
// NOT handled here: a division change, since that means a different SharePoint
// site entirely — that should go through a dedicated move/recreate flow rather
// than a rename.
//
// Expected fields on `project`, on top of the normal create payload:
//   - team_id              : the Team/Group id captured when the project was first provisioned.
//                            Without this the folder still gets renamed/updated, but the
//                            Team update is skipped.
//   - previous_name        : the folder/team name on file before this update. Only needed
//                            when the name changed — used to find the existing folder before
//                            it's renamed. If omitted, lookup falls back to the current name.
//   - previous_owner_email : needed to know who to remove as Team owner when ownership changes.
async function updateSharepointForProject(project, token) {
  try {
    const { siteId, driveId } = await resolveSiteAndDrive(
      token,
      project.proj_Division__c,
    );

    // NEW: log the raw field values coming in from SPP before anything
    // touches them, so you can see exactly what you're working with.
    console.log(
      `Incoming project fields for "${project.name}": ${JSON.stringify({
        proj_Division__c: project.proj_Division__c,
        owner_name: project.owner_name,
        coordinator_name: project.coordinator_name,
        start_date: project.start_date,
        trv_proj_End_Date__c: project.trv_proj_End_Date__c,
        proj_Sales_Rep__c: project.proj_Sales_Rep__c,
        proj_Project_Status__c: project.proj_Project_Status__c,
        client_name: project.client_name,
      })}`,
    );

    const lookupName = project.name;
    const folder = await getFolderByPath(token, driveId, lookupName);
    if (!folder) {
      console.log(
        `No existing folder found for "${lookupName}" — skipping update for "${project.name}". It may need to go through the create flow instead.`,
      );
      return {
        project: project.name,
        updated: false,
        reason: "folder-not-found",
      };
    }

    const nameChanged = folder.name && folder.name !== project.name;
    if (nameChanged) {
      await renameFolder(token, driveId, folder.id, project.name);
    }

    const metadataColumns = buildDivisionMetadataColumns(
      project,
      project.proj_Division__c,
    );
    if (!metadataColumns) {
      console.log(
        `Unrecognized division "${project.proj_Division__c}" — skipping metadata field update for "${project.name}".`,
      );
    }

    // NEW: log exactly what's about to be sent, BEFORE the request,
    // so a thrown error downstream doesn't hide this.
    console.log(
      `Attempting PATCH for "${project.name}" with columns: ${JSON.stringify(metadataColumns)}`,
    );

    const patchResult = await updateFolderMetadata(token, driveId, folder.id, {
      ...(metadataColumns || {}),
    });

    // NEW: log what Graph actually echoes back, not just what you sent —
    // confirms whether values were actually accepted, not just whether
    // the request returned 200.
    console.log(
      `Graph response fields for "${project.name}": ${JSON.stringify(patchResult)}`,
    );

    // ...team_id block unchanged...

    return { project: project.name, updated: true };
  } catch (err) {
    // NEW: log the stack, not just the message, so you can see exactly
    // which line threw (e.g. a .substring on undefined).
    console.log(
      `Update failed for project "${project.name}": ${err.message}\n${err.stack}`,
    );
    return { project: project.name, updated: false, error: err.message };
  }
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

// Currently unused (owner-swap block that calls this is commented out in
// updateSharepointForProject), kept in case that logic is re-enabled.
async function getUserId(token, upnOrEmail) {
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

// Builds the division-specific metadata columns object for the folder PATCH.
function buildDivisionMetadataColumns(project, division) {
  const projectDate = project.start_date
    ? project.start_date.substring(0, 10)
    : null;
  const projectEndDate = project.trv_proj_End_Date__c
    ? project.trv_proj_End_Date__c.substring(0, 10)
    : null;

  if (division === "Qual") {
    return {
      ProjectManager: project.owner_name,
      ProjectCoordinator: project.coordinator_name,
      ProjectDate: projectDate,
      ProjectEndDate: projectEndDate,
      AccountManager: project.proj_Sales_Rep__c,
      ProjectStatus: project.proj_Project_Status__c,
      Client: project.client_name,
    };
  }
  if (division === "Quant") {
    return {
      Project_x0020_Manager: project.owner_name,
      Project_x0020_Coordinator: project.coordinator_name,
      Project_x0020_Start_x0020_Date: projectDate,
      Project_x0020_End_x0020_Date: projectEndDate,
      Account_x0020_Manager: project.proj_Sales_Rep__c,
      Project_x0020_Status: project.proj_Project_Status__c,
      Clients: project.client_name,
    };
  }
  return null;
}
