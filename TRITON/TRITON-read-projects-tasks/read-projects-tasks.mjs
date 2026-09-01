// SuiteProjects Pro reads for the Time Entry Reallocation tool.
// Deployed at: https://qswxt37g563vjqakg36ft7enqa0gelml.lambda-url.us-east-2.on.aws/
//
// GET ?type=projects              -> [{ id, name }, ...]  (projects in the configured stage(s))
// GET ?type=tasks&projectId=1234  -> [{ id, name }, ...]  (tasks for ONE project, called on-demand)
//
// Env vars:
//   SPP_BASE_URL          e.g. https://triton-env-sb.app.sandbox.netsuitesuiteprojectspro.com/rest/v1
//   SPP_INTEGRATION_KEY   defaults to 'spp-triton-sandbox'
//   SPP_DEFAULT_STAGE_IDS comma-separated projectStageId list, defaults to '3'

const TOKEN_URL = 'https://mfuzb7y7b4uwqbe25ysh4qdzie0jtxqx.lambda-url.us-east-2.on.aws/';
const INTEGRATION_KEY = process.env.SPP_INTEGRATION_KEY || 'spp-triton-sandbox';
const BASE_URL = process.env.SPP_BASE_URL;
const DEFAULT_STAGE_IDS = process.env.SPP_DEFAULT_STAGE_IDS
  ? process.env.SPP_DEFAULT_STAGE_IDS.split(',').map(Number)
  : [3];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // tighten to your hosting origin once deployed
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function getAccessToken() {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ integrationKey: INTEGRATION_KEY }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Token request failed (${response.status}): ${errBody}`);
  }

  const body = await response.json();
  const token = body?.results?.[0]?.accessToken;

  if (!token) {
    throw new Error(`No accessToken found in token response: ${JSON.stringify(body)}`);
  }

  return token;
}

// Builds a filter clause for one or more internal IDs on a given field.
// Single value:    fieldName EQUAL 12
// Multiple values: fieldName ANY_OF [12,15,18]
function buildIdFilter(fieldName, ids) {
  const list = Array.isArray(ids) ? ids : [ids];

  if (list.length === 0) {
    throw new Error(`At least one value for ${fieldName} is required`);
  }

  const nums = list.map((id) => {
    const n = Number(id);
    if (!Number.isInteger(n)) {
      throw new Error(`Invalid ${fieldName} value: ${id}`);
    }
    return n;
  });

  return nums.length === 1
    ? `${fieldName} EQUAL ${nums[0]}`
    : `${fieldName} ANY_OF [${nums.join(',')}]`;
}

// Generic paginated GET, following meta.links "next" until exhausted
async function fetchAllPages(initialUrl, accessToken) {
  const results = [];
  let url = initialUrl;

  while (url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`SuiteProjects Pro request failed (${response.status}): ${errBody}`);
    }

    const body = await response.json();
    results.push(...(body.data || []));

    const nextLink = body.meta?.links?.find((l) => l.rel === 'next');
    url = nextLink ? nextLink.href : null;
  }

  return results;
}

async function getProjects(stageIds, accessToken) {
  const stageFilter = buildIdFilter('projectStageId', stageIds);
  const url = `${BASE_URL}/projects/?q=${encodeURIComponent(stageFilter)}&fields=id,name&limit=1000&offset=0`;
  const projects = await fetchAllPages(url, accessToken);
  return projects.map((p) => ({ id: String(p.id), name: p.name }));
}

async function getProjectTasks(projectId, accessToken) {
  const taskFilter = buildIdFilter('projectId', projectId);
  const url = `${BASE_URL}/project-tasks/?q=${encodeURIComponent(taskFilter)}&fields=id,name,projectId&limit=1000&offset=0`;
  const tasks = await fetchAllPages(url, accessToken);
  return tasks.map((t) => ({ id: String(t.id), name: t.name }));
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  const qs = event?.queryStringParameters || {};

  if (event?.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  try {
    const accessToken = await getAccessToken();
    const type = qs.type || 'projects';

    if (type === 'projects') {
      const stageIds = qs.stageIds ? qs.stageIds.split(',').map(Number) : DEFAULT_STAGE_IDS;
      const projects = await getProjects(stageIds, accessToken);
      return jsonResponse(200, projects);
    }

    if (type === 'tasks') {
      console.log('Fetching tasks for project:', qs.projectId);
      if (!qs.projectId) {
        return jsonResponse(400, { message: 'projectId query param is required for type=tasks' });
      }
      const tasks = await getProjectTasks(qs.projectId, accessToken);
      return jsonResponse(200, tasks);
    }

    // TEMP DEBUG: peek at raw project-tasks response (including meta), either
    // unfiltered or filtered by projectId if provided. Remove once the
    // filter in getProjectTasks() is confirmed correct.
    // NOTE: single fetch only (no fetchAllPages) -- limit caps the *page
    // size*, not the total, so following meta.links.next on an unfiltered
    // call would page through the entire org's project-tasks and time out.
    if (type === 'debug-tasks') {
      const filterClause = qs.projectId ? buildIdFilter('projectId', qs.projectId) : null;
      const qParam = filterClause ? `q=${encodeURIComponent(filterClause)}&` : '';
      const url = `${BASE_URL}/project-tasks/?${qParam}fields=id,name,projectId&limit=5&offset=0`;
      console.log('Debug URL:', url);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      const rawBody = await response.text();
      console.log('Debug raw response:', rawBody);
      if (!response.ok) {
        return jsonResponse(response.status, { message: `SPP error: ${rawBody}` });
      }
      // Return the FULL parsed body (data + meta), not just data, so we can
      // see totalRows / message alongside the rows.
      return jsonResponse(200, JSON.parse(rawBody));
    }

    // TEMP DEBUG: look up a single project by its raw internal id, to
    // confirm the id we're testing with actually matches the project we
    // think it does (as opposed to a project number/code shown in the UI
    // that isn't the same field as the API's internal id).
    if (type === 'debug-project') {
      if (!qs.id) {
        return jsonResponse(400, { message: 'id query param is required for type=debug-project' });
      }
      const filterClause = buildIdFilter('id', qs.id);
      const url = `${BASE_URL}/projects/?q=${encodeURIComponent(filterClause)}&fields=id,name,projectStageId&limit=5&offset=0`;
      console.log('Debug project URL:', url);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      const rawBody = await response.text();
      console.log('Debug project raw response:', rawBody);
      if (!response.ok) {
        return jsonResponse(response.status, { message: `SPP error: ${rawBody}` });
      }
      return jsonResponse(200, JSON.parse(rawBody));
    }

    return jsonResponse(400, { message: `Unknown type: ${type}` });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { message: err.message });
  }
};
