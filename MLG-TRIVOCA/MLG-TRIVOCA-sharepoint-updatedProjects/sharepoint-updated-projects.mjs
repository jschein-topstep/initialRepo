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
  Qual: "/sites/QualProjects",
  Quant: "/sites/QuantProjects", // adjust if the actual Quant site path differs
};

// Retrieve projects from SPP read (passed via lambda function call)
export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.body);
  console.log(`bodyJSON: ${JSON.stringify(bodyJSON)}`);

  const hasNewProjects =
    Array.isArray(bodyJSON.projects) && bodyJSON.projects.length > 0;
  const hasUpdatedProjects =
    Array.isArray(bodyJSON.updatedProjects) &&
    bodyJSON.updatedProjects.length > 0;

  if (!hasNewProjects && !hasUpdatedProjects) {
    console.log("No new or updated projects in payload");
    return;
  }

  const token = await getGraphToken();

  if (hasNewProjects) {
    await Promise.all(
      bodyJSON.projects.map(async (project) => {
        const ownerId = await getUserId(token, project.owner_email); // email of the proj owner
        const teamId = await newSharepointTeam(token, project.name, ownerId);

        await createFoldersInSharepoint(project, token);
      }),
    );
  }

  if (hasUpdatedProjects) {
    const results = await Promise.all(
      bodyJSON.updatedProjects.map((project) =>
        updateSharepointForProject(project, token),
      ),
    );
    console.log(`Update results: ${JSON.stringify(results)}`);
  }
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

  const data = await res.json();
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

// Create folders and subfolders in Sharepoint for each NEW project (Loop A, Yes branch, first action)
async function createFoldersInSharepoint(project, token) {
  const sitePath = SITE_PATH_BY_DIVISION[project.proj_Division__c];
  console.log(`sitePath: ${sitePath}`);
  if (!sitePath) {
    console.log(
      `No site path configured for division: ${project.proj_Division__c}`,
    );
    return { deleted: false };
  }
  const siteId = await getSiteId(token, sitePath);
  console.log(`siteId: ${siteId}`);

  const driveId = await getDriveId(token, siteId);
  console.log(`driveId: ${driveId}`);

  // Generic folder creation, works at root OR under a parent item
  async function createFolder(token, driveId, folderName, parentId = null) {
    const endpoint = parentId
      ? `${GRAPH_BASE}/drives/${driveId}/items/${parentId}/children`
      : `${GRAPH_BASE}/drives/${driveId}/root/children`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        `Folder creation failed for "${folderName}"${
          parentId ? ` under parent ${parentId}` : " at root"
        }: ${JSON.stringify(data)}`,
      );
    }
    console.log(`Folder created: ${folderName} -> id: ${data.id}`);
    return data;
  }

  // Recursively walks a folder tree definition and creates each node.
  // `node` can be a plain string (leaf, no children) or an object:
  //   { name: "Accounting+Compliance", children: [ "Compliance Materials", { name: "..." , children: [...] } ] }
  async function createFolderTree(token, driveId, node, parentId) {
    const name = typeof node === "string" ? node : node.name;
    const children = typeof node === "string" ? [] : node.children || [];

    const created = await createFolder(token, driveId, name, parentId);

    if (children.length) {
      await Promise.all(
        children.map((child) =>
          createFolderTree(token, driveId, child, created.id),
        ),
      );
    }

    return created;
  }

  // Define the full structure once, declaratively
  const folderStructure = [
    {
      name: "Accounting+Compliance",
      children: ["Compliance Materials", "Invoicing"],
    },
    "Client Lists",
    {
      name: "Project Management",
      children: [
        {
          name: "Project Materials",
          children: ["NDAs", "Prework", "Schedule", "Screener+Algorithm"],
        },
        "Recruiting Updates",
      ],
    },
  ];

  const projectFolder = await createFolder(token, driveId, project.name);

  // Metadata on the project folder itself
  await addMetadataToSharepointFolder(
    token,
    project,
    projectFolder.id,
    siteId,
    driveId,
  );

  console.log(`Creating folder structure for: ${project.name}`);
  await Promise.all(
    folderStructure.map((node) =>
      createFolderTree(token, driveId, node, projectFolder.id),
    ),
  );

  return projectFolder;
}

// Add metadata to the Sharepoint folder for each NEW project (Loop A, Yes branch, second action)
// Confirm if this should be its own function or live in the createFoldersInSharepoint function
async function addMetadataToSharepointFolder(
  token,
  project,
  folderId,
  siteId,
  driveId,
) {
  console.log(`Entering metadata function`);
  //"LinkFilename", //name?
  // "Account Rep", // not found
  const RELEVANT_COLUMNS = [
    "Year",
    "ProjectManager",
    "ProjectCoordinator",
    "Clients",
    "Account_x0020_Manager",
  ];

  async function getLibraryColumns(
    token,
    siteId,
    filterNames = RELEVANT_COLUMNS,
  ) {
    const listRes = await fetch(
      `${GRAPH_BASE}/sites/${siteId}/lists/Documents`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const listData = await listRes.json();
    if (!listRes.ok) {
      throw new Error(
        `Failed to resolve Documents list: ${JSON.stringify(listData)}`,
      );
    }
    const listId = listData.id;

    const colRes = await fetch(
      `${GRAPH_BASE}/sites/${siteId}/lists/${listId}/columns?$select=name,displayName,columnGroup,hidden,readOnly`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const colData = await colRes.json();
    if (!colRes.ok) {
      throw new Error(`Failed to get columns: ${JSON.stringify(colData)}`);
    }

    const relevant = colData.value.filter((col) =>
      filterNames.includes(col.name),
    );

    relevant.forEach((col) => {
      console.log(`internal: ${col.name}  |  display: ${col.displayName}`);
    });

    return relevant;
  }
  let columns = await getLibraryColumns(token, siteId);

  const spOwnerId = await getSharepointUserId(
    token,
    siteId,
    project.owner_email,
  );
  const spCoordinatorId = await getSharepointUserId(
    token,
    siteId,
    project.coordinator_email,
  );

  await updateFolderMetadata(token, driveId, folderId, {
    Year: String(new Date().getFullYear()),
    ProjectManagerLookupId: spOwnerId,
    ProjectCoordinatorLookupId: spCoordinatorId,
    Clients: "Dexcom",
    /*FileLeafRef
Account_x0020_Manager (confirm)
Clients
ProjectCoordinator*/
  });
}

// Email project owner once creation is complete (maybe SPP action?)
async function emailProjectOwner(project) {}

// Create a Sharepoint Team Site for each NEW project (Loop A, Yes branch, second path, first action)
async function newSharepointTeam(token, teamName, ownerId, description = "") {
  const res = await fetch(`${GRAPH_BASE}/teams`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      "template@odata.bind":
        "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
      displayName: teamName,
      description,
      members: [
        {
          "@odata.type": "#microsoft.graph.aadUserConversationMember",
          roles: ["owner"],
          "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${ownerId}')`,
        },
      ],
    }),
  });

  if (res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Team creation failed: ${JSON.stringify(data)}`);
  }

  const operationUrl = res.headers.get("Location");
  console.log(
    `Team creation started for "${teamName}", polling: ${operationUrl}`,
  );
  return await pollTeamCreation(token, operationUrl);
}

async function pollTeamCreation(
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
    console.log(
      `res ${JSON.stringify(res)} concat ${GRAPH_BASE}${operationUrl}`,
    );
    const data = await res.json();
    lastStatus = data.status;
    console.log(
      `Poll attempt ${attempt}: status = ${data.status} data = ${JSON.stringify(data)}`,
    );

    if (data.status === "succeeded") {
      const teamId =
        data.targetResourceLocation?.match(/teams\('(.+)'\)/)?.[1] ??
        data.resourceLocation?.match(/teams\('(.+)'\)/)?.[1];
      if (!teamId) {
        throw new Error(
          `Team succeeded but no teamId found in: ${JSON.stringify(data)}`,
        );
      }
      return teamId;
    }
    if (data.status === "failed") {
      throw new Error(
        `Team creation operation failed: ${JSON.stringify(data)}`,
      );
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error(
    `Team creation timed out after ${maxAttempts} attempts for operation: ${operationUrl}. Last known status: "${lastStatus}"`,
  );
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

    const lookupName = project.previous_name || project.name;
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

    const nameChanged =
      project.previous_name && project.previous_name !== project.name;
    if (nameChanged) {
      await renameFolder(token, driveId, folder.id, project.name);
    }

    const spOwnerId = await getSharepointUserId(
      token,
      siteId,
      project.owner_email,
    );
    const spCoordinatorId = await getSharepointUserId(
      token,
      siteId,
      project.coordinator_email,
    );
    await updateFolderMetadata(token, driveId, folder.id, {
      ProjectManagerLookupId: spOwnerId,
      ProjectCoordinatorLookupId: spCoordinatorId,
    });

    if (project.team_id) {
      if (nameChanged) {
        await updateTeamProperties(token, project.team_id, {
          displayName: project.name,
        });
      }
      if (
        project.previous_owner_email &&
        project.previous_owner_email !== project.owner_email
      ) {
        const newOwnerId = await getUserId(token, project.owner_email);
        const oldOwnerId = await getUserId(token, project.previous_owner_email);
        await addTeamOwner(token, project.team_id, newOwnerId);
        await removeTeamOwner(token, project.team_id, oldOwnerId);
      }
    } else {
      console.log(
        `No team_id on project "${project.name}" — skipping Team update.`,
      );
    }

    return { project: project.name, updated: true };
  } catch (err) {
    console.log(`Update failed for project "${project.name}": ${err.message}`);
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
