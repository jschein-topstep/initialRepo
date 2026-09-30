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
  // Confirmed working 2026-09-25: GET /rest/v1/customers returns a
  // filter-set-scoped id list (paginated, same {data:[{id}], meta.links}
  // shape as projects/users) -- verified end to end against a real
  // connected user (filter set 1, unrestricted): REST returned every
  // non-deleted customer and nothing else, matching the full synced
  // customer.csv exactly once the 3 deleted rows are excluded.
  customers: "customers",
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

function extractIds(json) {
  const ids = [];
  for (const row of json.data ?? []) {
    if (Number.isInteger(row.id)) ids.push(row.id);
  }
  return ids;
}

async function fetchOnePage(url, accessToken, recordType) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Fetching ${recordType} failed [${response.status}]: ${await response.text()}`,
    );
  }
  return response.json();
}

// Runs `items` through `worker` with at most `limit` in flight at once --
// hand-rolled instead of a library since it's this small. Order of results
// doesn't matter to any caller here (permitted-id sets), so this doesn't
// bother preserving it.
async function mapWithConcurrency(items, limit, worker) {
  const results = [];
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results.push(await worker(items[i], i));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// Page fetches for one record type run CONCURRENTLY (page 1 first, alone,
// since it's the only way to learn how many pages exist at all; the rest
// fan out together) rather than one at a time -- this is a genuinely
// I/O-bound wait (round-trip to SPP's own server), unlike DuckDB table
// materialization elsewhere in this project where concurrency was tested
// and found to give zero benefit (that's CPU-bound). Necessary in
// practice, not just a nice-to-have: confirmed against BGB's real SPP
// instance, which has 47,427 projects across 48 pages at ~3.7-4s/page --
// sequentially that's 3+ minutes, blowing past every timeout in the
// request path (this Lambda's own, and API Gateway's separate hard
// 30-second cap) long before finishing, which is what sync_spp_access
// hanging in production actually was.
//
// 16 was chosen empirically against BGB's real 48-page projects fetch:
// sequential ~200s; concurrency 8 -> 29.3s (still right at the 30s cap
// with no margin); 16 -> 17.6s; 24 -> 14.2s (diminishing returns already --
// only 3.4s better than 16 for meaningfully more concurrent load on a
// partner's live production SPP instance). 16 gives comfortable headroom
// under the 30s cap without pushing harder than the improvement justifies.
const PAGE_CONCURRENCY = 16;

async function fetchPermittedIds(baseUrl, accessToken, recordType) {
  const path = RECORD_TYPE_PATHS[recordType];
  if (!path) {
    throw new Error(`Unsupported record type for REST fetch: ${recordType}`);
  }

  const firstUrl = `${baseUrl}/${path}?fields=id&limit=1000`;
  const firstPage = await fetchOnePage(firstUrl, accessToken, recordType);
  const ids = extractIds(firstPage);

  const totalPages = firstPage.meta?.totalPages ?? 1;
  const rowsPerPage = firstPage.meta?.rowsPerPage ?? 1000;
  if (totalPages <= 1) {
    return ids;
  }

  // Pages are plain offset-based URLs (confirmed from SPP's own "next"/
  // "last" links), so the remaining pages' URLs can be built directly
  // rather than only discovered one "next" link at a time -- that's what
  // makes fetching them concurrently possible at all.
  const remainingPageIndexes = Array.from({ length: totalPages - 1 }, (_, i) => i + 1);
  const pageResults = await mapWithConcurrency(remainingPageIndexes, PAGE_CONCURRENCY, async (pageIndex) => {
    const url = `${baseUrl}/${path}?fields=id&limit=${rowsPerPage}&offset=${pageIndex * rowsPerPage}`;
    const page = await fetchOnePage(url, accessToken, recordType);
    return extractIds(page);
  });
  for (const pageIds of pageResults) ids.push(...pageIds);

  return ids;
}

// Returns { projects: [...ids], users: [...ids] } for the given person, or
// null if they haven't connected their SPP account yet. recordTypes
// defaults to every type this module supports. The different record types
// are independent of each other (not just their pages), so they fetch
// concurrently too.
async function fetchPermittedIdsForUser(email, recordTypes = Object.keys(RECORD_TYPE_PATHS)) {
  const accessToken = await sppUserAuth.getSppAccessTokenForUser(email);
  if (!accessToken) {
    return null;
  }

  const baseConfig = await sppUserAuth.getBaseSppConfig();
  const baseUrl = restBaseUrl(baseConfig);

  await refreshFilterSetCache(baseUrl, accessToken);

  const entries = await Promise.all(
    recordTypes.map(async (recordType) => [
      recordType,
      await fetchPermittedIds(baseUrl, accessToken, recordType),
    ]),
  );
  return Object.fromEntries(entries);
}

module.exports = {
  fetchPermittedIdsForUser,
  RECORD_TYPE_PATHS,
};
