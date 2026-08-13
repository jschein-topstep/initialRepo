import { parse } from "csv-parse/sync";
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
  bodyJSON.projects.forEach((project) => {
    // QUAL or QUANT?
    if (project.proj_Division__c === "QUAL") {
      console.log(`QUAL project: ${project.name}`);
      createFoldersInSharepointQUAL(project, token).catch((error) => {
        console.error(
          `Error creating folders for project ${project.name}: ${error.message}`,
        );
      });
    } else if (project.proj_Division__c === "QUANT") {
      console.log(`QUANT project: ${project.name}`);
      createFoldersInSharepointQUANT(project, token).catch((error) => {
        console.error(
          `Error creating folders for project ${project.name}: ${error.message}`,
        );
      });
    } else {
      console.log(`No QUAL or QUANT projects found`);
    }
  });
};

// Create folders and subfolders in Sharepoint for each NEW project (Loop A, Yes branch, first action)
async function createFoldersInSharepointQUAL(project, token) {
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

  // 1. Resolve the site ID once (cache this — it doesn't change)
  async function getSiteId(token) {
    const hostname = "trivocahealth.sharepoint.com";
    const sitePath = "/sites/QualProjects";

    const res = await fetch(`${GRAPH_BASE}/sites/${hostname}:${sitePath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Failed to resolve site: ${JSON.stringify(data)}`);
    }
    return data.id;
  }
  const siteId = await getSiteId(token);
  // 2. Get the default document library's drive ID for that site
  async function getDriveId(token, siteId) {
    const res = await fetch(`${GRAPH_BASE}/sites/${siteId}/drive`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Failed to resolve drive: ${JSON.stringify(data)}`);
    }
    return data.id;
  }
  const driveId = await getDriveId(token, siteId);

  // 3. Create a folder under a given parent path
  async function createFolder(token, driveId, parentPath, folderName) {
    const res = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/items/${parentPath}:/children`,
      {
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
      },
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Folder creation failed: ${JSON.stringify(data)}`);
    } else {
      console.log(
        `Folder created successfully: ${project.name} -> id: ${data.id}, name: ${data.name}`,
      );
    }
    await createSubFolders(token, driveId, "root:/" + data.name, [
      "Accounting+Compliance",
      "Project Management",
    ]);
  }
  async function createSubFolders(
    token,
    driveId,
    parentPath,
    childFolderNames = [],
  ) {
    const res = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/items/${parentPath}:/children`,
      {
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
      },
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Folder creation failed: ${JSON.stringify(data)}`);
    }

    console.log(
      `Folder created successfully: ${folderName} -> id: ${data.id}, name: ${data.name}`,
    );

    // Create child folders inside the one we just created
    if (childFolderNames.length > 0) {
      const childPath = `${parentPath === "root" ? "root" : parentPath}:/${folderName}`;

      await Promise.all(
        childFolderNames.map((childName) =>
          createFolder(token, driveId, childPath, childName),
        ),
      );
    }

    return data;
  }

  await createFolder(token, driveId, "root", project.name);
}

// Create folders and subfolders in Sharepoint for each NEW project (Loop A, Yes branch, first action)
async function createFoldersInSharepointQUANT(project, token) {
  const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

  // 1. Resolve the site ID once (cache this — it doesn't change)
  async function getSiteId(token) {
    const hostname = "trivocahealth.sharepoint.com";
    const sitePath = "/sites/QuantProjects";

    const res = await fetch(`${GRAPH_BASE}/sites/${hostname}:${sitePath}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Failed to resolve site: ${JSON.stringify(data)}`);
    }
    return data.id;
  }
  const siteId = await getSiteId(token);
  // 2. Get the default document library's drive ID for that site
  async function getDriveId(token, siteId) {
    const res = await fetch(`${GRAPH_BASE}/sites/${siteId}/drive`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Failed to resolve drive: ${JSON.stringify(data)}`);
    }
    return data.id;
  }
  const driveId = await getDriveId(token, siteId);

  // 3. Create a folder under a given parent path
  async function createFolder(token, driveId, parentPath, folderName) {
    const res = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/items/${parentPath}:/children`,
      {
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
      },
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Folder creation failed: ${JSON.stringify(data)}`);
    } else {
      console.log(
        `Folder created successfully: ${project.name} -> id: ${data.id}, name: ${data.name}`,
      );
    }
    await createSubFolders(token, driveId, "root:/" + data.name, [
      "Accounting+Compliance",
      "Project Management",
    ]);
  }
  async function createSubFolders(
    token,
    driveId,
    parentPath,
    childFolderNames = [],
  ) {
    const res = await fetch(
      `${GRAPH_BASE}/drives/${driveId}/items/${parentPath}:/children`,
      {
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
      },
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Folder creation failed: ${JSON.stringify(data)}`);
    }

    console.log(
      `Folder created successfully: ${folderName} -> id: ${data.id}, name: ${data.name}`,
    );

    // Create child folders inside the one we just created
    if (childFolderNames.length > 0) {
      const childPath = `${parentPath === "root" ? "root" : parentPath}:/${folderName}`;

      await Promise.all(
        childFolderNames.map((childName) =>
          createFolder(token, driveId, childPath, childName),
        ),
      );
    }

    return data;
  }

  await createFolder(token, driveId, "root", project.name);
}

// Add metadata to the Sharepoint folder for each NEW project (Loop A, Yes branch, second action)
// Confirm if this should be its own function or live in the createFoldersInSharepoint function
async function addMetadataToSharepointFolder(project, folderId) {}

// Email project owner once creation is complete (maybe SPP action?)
async function emailProjectOwner(project) {}

// Create a Sharepoint Team Site for each NEW project (Loop A, Yes branch, second path, first action)
async function createSharepointTeam(project) {}

async function getGraphToken() {
  const url = `https://login.microsoftonline.com/07df17c1-4112-495c-b15f-76a25f844f3d/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: "82c08c90-bc61-4af4-ad27-7f7e3d838c1c",
    client_secret: "668099ae-5179-4f82-98d4-faacaff4dba6",
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
