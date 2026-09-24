// Enforces filter-set access at the query layer: replaces "projects" and
// "users" with views scoped to the current caller's cached permitted IDs,
// so the agent's arbitrary SQL (execute_spp_query) is automatically scoped
// no matter how it's written -- the agent never sees a row it shouldn't.
//
// Why the raw materialized tables get renamed to "*_raw" rather than
// building the view directly as "CREATE OR REPLACE VIEW projects AS SELECT
// * FROM projects WHERE ...": this Lambda's DuckDB connection is cached and
// reused across warm-container invocations, potentially for different
// people. A self-referential CREATE OR REPLACE (view named "projects"
// selecting FROM "projects") would bind to whatever currently answers to
// that name -- on the second caller in the same container, that's the
// FIRST caller's already-filtered view, not the raw table, silently
// intersecting two different people's access instead of scoping each
// person's request independently. Renaming the raw table once (idempotent,
// self-healing after index.js re-materializes it) gives the view a stable,
// unshadowed source to always select from.

const { getCachedPermittedIds } = require("./filterCache.js");

const SCOPED_RECORD_TYPES = ["projects", "users"];

async function ensureRawTablesRenamed(connection) {
  const reader = await connection.runAndReadAll(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('${SCOPED_RECORD_TYPES.join("', '")}') AND table_type = 'BASE TABLE'
  `);
  const rows = await reader.getRowObjects();
  for (const row of rows) {
    await connection.run(`ALTER TABLE "${row.table_name}" RENAME TO "${row.table_name}_raw"`);
  }
}

function idsListSql(ids) {
  const safeIds = (ids ?? []).filter((id) => Number.isInteger(id) && id > 0);
  if (safeIds.length === 0) {
    return null;
  }
  return `SELECT UNNEST([${safeIds.join(", ")}]) AS id`;
}

// Rebuilds the "projects"/"users" views for the current request, scoped to
// `email`'s cached permitted IDs. Not connected yet (or no cache entry) ->
// both views resolve to zero rows -- fail closed, never fail open.
//
// Returns { hasSyncedAccess }: whether a cache entry exists at all. This
// matters because an empty result set looks identical to the agent whether
// the person isn't connected/synced yet or is connected with genuinely zero
// permitted rows -- there is no way to tell those apart from query results
// alone. Callers use this to make that distinction explicit rather than
// leaving the agent to guess (which it will get wrong).
async function applyFilterScope(connection, email) {
  await ensureRawTablesRenamed(connection);

  const cached = email ? await getCachedPermittedIds(email) : null;

  for (const recordType of SCOPED_RECORD_TYPES) {
    const idsSql = idsListSql(cached?.[recordType]);
    const permittedClause = idsSql ? `id IN (${idsSql})` : "FALSE";
    // Generic/service SPP user accounts (templates like "NewHire1-June",
    // not real people) are unconditionally excluded from SPP's own
    // filter-set-scoped REST API response, regardless of whose filter set
    // is applied -- confirmed empirically (0 of 36 generic users ever
    // appear, for every account checked), so fetchPermittedIds can never
    // include them no matter how broad someone's access is. There's no
    // real access-control reason to hide them (they're not anyone's
    // private data), so "users" always shows them alongside whatever's
    // permitted, bypassing the fail-closed permitted-IDs check just for
    // this flag.
    const whereClause =
      recordType === "users"
        ? `(${permittedClause} OR CAST(generic AS VARCHAR) = '1')`
        : permittedClause;
    await connection.run(
      `CREATE OR REPLACE VIEW "${recordType}" AS SELECT * FROM "${recordType}_raw" WHERE ${whereClause}`,
    );
  }

  return { hasSyncedAccess: cached !== null };
}

module.exports = { applyFilterScope, SCOPED_RECORD_TYPES };
