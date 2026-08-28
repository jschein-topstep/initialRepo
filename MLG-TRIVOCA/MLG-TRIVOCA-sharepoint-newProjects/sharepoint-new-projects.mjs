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
      const ownerId = await getUserId(token, project.owner_email); // email of the proj owner
      const teamId = await newSharepointTeam(token, project.name, ownerId);

      await createFoldersInSharepoint(project, token);
    }),
  );
};

// Create folders and subfolders in Sharepoint for each NEW project (Loop A, Yes branch, first action)
async function createFoldersInSharepoint(project, token) {
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
  const hostname = "trivocahealth.sharepoint.com";
  const SITE_PATH_BY_DIVISION = {
    Qual: "/sites/QualProjects",
    Quant: "/sites/QuantProjects", // adjust if the actual Quant site path differs
  };

  let sitePath;
  if (project.proj_Division__c == "Qual") {
    sitePath = SITE_PATH_BY_DIVISION.Qual;
  } else if (project.proj_Division__c == "Quant") {
    sitePath = SITE_PATH_BY_DIVISION.Quant;
  }
  console.log(`sitePath: ${sitePath}`);
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
  const RELEVANT_COLUMNS = [
    "Year",
    "ProjectManager",
    "FileLeafRef",
    "Clients",
    "ProjectCoordinator",
    "Account_x0020_Manager",
  ];

  async function getLibraryColumns(
    token,
    siteId,
    filterNames = RELEVANT_COLUMNS,
  ) {
    const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

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

  async function getSharepointUserId(token, siteId, upnOrEmail) {
    const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

    // Looks up the user's row in this site's hidden "User Information List" —
    // that row's numeric id is what personOrGroup fields (like ProjectManagerLookupId) need.
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
  const spOwnerId = await getSharepointUserId(
    token,
    siteId,
    project.owner_email,
  );

  async function updateFolderMetadata(token, driveId, itemId, columns) {
    const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

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
  await updateFolderMetadata(token, driveId, folderId, {
    Year: String(new Date().getFullYear()),
    ProjectManagerLookupId: spOwnerId,
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
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

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
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
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
