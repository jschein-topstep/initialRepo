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
};

// Validate the projects retrieved from SPP meet filter criteria (Loop A, first decision)
async function projectFilterValidation(projects) {}

// Create folders and subfolders in Sharepoint for each NEW project (Loop A, Yes branch, first action)
async function createFoldersInSharepoint(project) {}

// Add metadata to the Sharepoint folder for each NEW project (Loop A, Yes branch, second action)
// Confirm if this should be its own function or live in the createFoldersInSharepoint function
async function addMetadataToSharepointFolder(project, folderId) {}

// Email project owner once creation is complete (maybe SPP action?)
async function emailProjectOwner(project) {}

// Create a Sharepoint Team Site for each NEW project (Loop A, Yes branch, second path, first action)
async function createSharepointTeam(project) {}
