const TOKEN_URL = 'https://mfuzb7y7b4uwqbe25ysh4qdzie0jtxqx.lambda-url.us-east-2.on.aws/';
const INTEGRATION_KEY = process.env.SPP_INTEGRATION_KEY || 'spp-triton-sandbox';

const BASE_URL = process.env.SPP_BASE_URL; // e.g. https://company-id.app.netsuitesuiteprojectspro.com/rest/v1

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

  // Mirrors: sppAccess.body.results[0].accessToken
  const token = body?.results?.[0]?.accessToken;

  if (!token) {
    throw new Error(`No accessToken found in token response: ${JSON.stringify(body)}`);
  }

  return token;
}

// Builds a filter clause for one or more project stage internal IDs.
// Single stage:    projectStageId EQUAL 12
// Multiple stages: projectStageId ANY_OF [12,15,18]
function buildStageFilter(stageIds) {
  const list = Array.isArray(stageIds) ? stageIds : [stageIds];

  if (list.length === 0) {
    throw new Error('At least one projectStageId is required');
  }

  const ids = list.map((id) => {
    const n = Number(id);
    if (!Number.isInteger(n)) {
      throw new Error(`Invalid projectStageId: ${id}`);
    }
    return n;
  });

  if (ids.length === 1) {
    return `projectStageId EQUAL ${ids[0]}`;
  }

  return `projectStageId ANY_OF [${ids.join(',')}]`;
}

async function getProjectsByStage(stageIds, accessToken) {
  const allProjects = [];
  const stageFilter = buildStageFilter(stageIds);
  console.log(`Stage filter: ${stageFilter}`);
  let url = `${BASE_URL}/projects/?q=${encodeURIComponent(stageFilter)}&fields=id,name&limit=1000&offset=0`;
    console.log(`Initial URL: ${url}`);
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
    allProjects.push(...(body.data || []));

    const nextLink = body.meta?.links?.find((l) => l.rel === 'next');
    url = nextLink ? nextLink.href : null;
  }

  return allProjects;
}

export const handler = async (event) => {
  try {
    const stageIds = event?.stageIds || [3]; // replace with real internal ID(s)
     console.log(`stageIds:'${JSON.stringify(stageIds)}'`);

    const accessToken = await getAccessToken();
    console.log(`accessToken:'${accessToken}'`);

    //const projects = await testGetProjectsByStage(stageIds, accessToken, event?.count || 5);
    const projects = await getProjectsByStage(stageIds, accessToken);
    console.log(`projects:'${JSON.stringify(projects)}'`);

    return {
      statusCode: 200,
      body: JSON.stringify({ count: projects.length, projects }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: err.message }),
    };
  }
};