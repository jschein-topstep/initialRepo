// Fetches the set of record IDs a specific person is allowed to see for a
// given record type, via SPP's REST API using their own per-user access
// token (see sppUserAuth.js). SPP applies that person's active filter set
// server-side -- this module doesn't interpret filter-set rules itself, it
// just asks SPP "what can this person see" and collects the resulting IDs.

const sppUserAuth = require("./sppUserAuth.js");

// Maps our record-type names to the REST API's collection endpoint path.
// Only record types the REST API actually exposes with filter-set
// enforcement belong here (see REST API Endpoint Reference) -- this is
// deliberately not the same list as the 9 filter-set record types overall.
const RECORD_TYPE_PATHS = {
  projects: "projects",
  users: "users",
};

function restBaseUrl(baseConfig) {
  return `${new URL(baseConfig.authorization_url).origin}/rest/v1`;
}

// The REST API caches filter-set info per access token and, by default,
// omits objects created after the token was issued even if the user can
// see them in the UI. This clears that cache so the fetch below reflects
// current state. See the "Filter Set Cache Refresh" help topic.
async function refreshFilterSetCache(baseUrl, accessToken) {
  // The body must be {"filterSet": true} -- an empty "{}" body is accepted
  // (200 OK) but does NOT actually invalidate the filter-set cache; it only
  // satisfies "a valid JSON body is required" without telling the endpoint
  // which cache to clear. Confirmed with a direct before/after test: with
  // "{}", a filter-set membership change added in SPP never appeared no
  // matter how many times this was called; with {"filterSet": true}, it
  // appeared on the very next call, no re-authentication needed. Not
  // documented in the REST API guide PDF (which just points to a separate
  // "Filter Set Cache Refresh" help topic that wasn't available to us).
  const response = await fetch(`${baseUrl}/session/cache/refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filterSet: true }),
  });
  if (!response.ok) {
    throw new Error(
      `Filter set cache refresh failed [${response.status}]: ${await response.text()}`,
    );
  }
}

async function fetchPermittedIds(baseUrl, accessToken, recordType) {
  const path = RECORD_TYPE_PATHS[recordType];
  if (!path) {
    throw new Error(`Unsupported record type for REST fetch: ${recordType}`);
  }

  const ids = [];
  let url = `${baseUrl}/${path}?fields=id&limit=1000`;

  while (url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `Fetching ${recordType} failed [${response.status}]: ${await response.text()}`,
      );
    }

    const json = await response.json();
    for (const row of json.data ?? []) {
      if (Number.isInteger(row.id)) ids.push(row.id);
    }

    const nextLink = json.meta?.links?.find((link) => link.rel === "next");
    url = nextLink?.href ?? null;
  }

  return ids;
}

// Returns { projects: [...ids], users: [...ids] } for the given person, or
// null if they haven't connected their SPP account yet. recordTypes
// defaults to every type this module supports.
async function fetchPermittedIdsForUser(email, recordTypes = Object.keys(RECORD_TYPE_PATHS)) {
  const accessToken = await sppUserAuth.getSppAccessTokenForUser(email);
  if (!accessToken) {
    return null;
  }

  const baseConfig = await sppUserAuth.getBaseSppConfig();
  const baseUrl = restBaseUrl(baseConfig);

  await refreshFilterSetCache(baseUrl, accessToken);

  const result = {};
  for (const recordType of recordTypes) {
    result[recordType] = await fetchPermittedIds(baseUrl, accessToken, recordType);
  }
  return result;
}

module.exports = {
  fetchPermittedIdsForUser,
  RECORD_TYPE_PATHS,
};
