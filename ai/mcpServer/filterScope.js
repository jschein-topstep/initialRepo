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
// self-healing after reportEngine.js re-materializes it) gives the view a stable,
// unshadowed source to always select from.

const { getCachedPermittedIds } = require("./filterCache.js");
const { resolveFilterSetPermittedValues } = require("./reportEngine.js");

const SCOPED_RECORD_TYPES = ["projects", "users", "customers"];

// Small SPP reference tables the REST API doesn't expose with filter-set
// enforcement (unlike SCOPED_RECORD_TYPES above), so they're scoped from a
// hand-curated static config instead of a live per-user REST fetch -- see
// reportEngine.js's resolveFilterSetPermittedValues/filter_sets.json.
// Extend this once a table is both synced (present in REPORT_VIEWS) AND
// curated in filter_sets.json -- slip stage and time type are known to be
// coming but aren't wired in yet on either side.
const STATIC_SCOPED_RECORD_TYPES = [
  "bookingTypes",
  "projectStages",
  "categories",
  "items",
];

async function ensureRawTablesRenamed(connection) {
  const allScoped = [...SCOPED_RECORD_TYPES, ...STATIC_SCOPED_RECORD_TYPES];
  const reader = await connection.runAndReadAll(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('${allScoped.join("', '")}') AND table_type = 'BASE TABLE'
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

// filter_sets.json permitted-id keys are hand-typed strings, not
// necessarily positive integers (SPP reference-table ids are usually small
// positive ints, but nothing guarantees that) -- quoted-string comparison
// via CAST(id AS VARCHAR) handles that generally, same reasoning as
// mergeIntoS3Csv's VARCHAR-everywhere approach elsewhere in this project.
function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Builds the WHERE clause for one static-scoped table from what
// resolveFilterSetPermittedValues returned for it: "all" -> unrestricted,
// a Set -> restricted to those ids, anything else (null -- no filter set,
// unknown filter set, or table not yet curated) -> fail closed.
function staticWhereClause(permitted) {
  if (permitted === "all") {
    return "TRUE";
  }
  if (permitted instanceof Set) {
    if (permitted.size === 0) {
      return "FALSE";
    }
    return `CAST(id AS VARCHAR) IN (${[...permitted].map(sqlQuote).join(", ")})`;
  }
  return "FALSE";
}

// Looks up the caller's own primary_filter_set from the just-renamed
// users_raw table (not the "users" view -- scoping it comes later in
// applyFilterScope, and self-referencing it would hit the exact same
// warm-container staleness problem the module comment at the top of this
// file describes). Case-insensitive match on email, matching filterCache.js's
// own normalization. Returns null -- not found, no users_raw yet (e.g.
// nothing materialized this container), or any query error -- rather than
// throwing; an unresolved filter set is exactly the fail-closed case
// resolveFilterSetPermittedValues already handles, and a query error here
// must not take down every OTHER tool in the request over one lookup.
async function getPrimaryFilterSetId(connection, email) {
  try {
    const reader = await connection.runAndReadAll(`
      SELECT CAST(primary_filter_set AS VARCHAR) AS pfs
      FROM users_raw
      WHERE lower(CAST(email AS VARCHAR)) = lower(${sqlQuote(email)})
      LIMIT 1
    `);
    const rows = await reader.getRowObjects();
    return rows.length ? rows[0].pfs : null;
  } catch (error) {
    console.log(`Could not resolve primary_filter_set for ${email}: ${error.message}`);
    return null;
  }
}

// Rebuilds the "projects"/"users"/"customers" views (live, REST-cache-based)
// AND the static reference-table views (booking type, project stage,
// category, item -- hand-curated-config-based) for the current request.
// Not connected yet (or no cache entry) -> the REST-scoped views resolve to
// zero rows. No resolvable filter set, or that table not yet curated in
// filter_sets.json -> the static-scoped views resolve to zero rows. Fail
// closed everywhere, never fail open.
//
// Returns { hasSyncedAccess }: whether a REST filter cache entry exists at
// all for this email. This matters because an empty result set looks
// identical to the agent whether the person isn't connected/synced yet or
// is connected with genuinely zero permitted rows -- there is no way to
// tell those apart from query results alone. Callers use this to make that
// distinction explicit rather than leaving the agent to guess (which it
// will get wrong). Reflects REST-cache status only, not static-table
// scoping -- someone can be fully connected while their primary_filter_set
// still isn't curated in filter_sets.json, which correctly fails closed on
// just those tables without affecting this flag.
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

  const filterSetId = email
    ? await getPrimaryFilterSetId(connection, email)
    : null;

  for (const recordType of STATIC_SCOPED_RECORD_TYPES) {
    // Isolated per table on purpose -- applyFilterScope runs unconditionally
    // on every request with no surrounding try/catch in mcp-handler.js, so
    // one missing/not-yet-materialized static table (e.g. slip stage before
    // it's synced) throwing here would otherwise break every tool call for
    // every table, not just this one. Fail this table closed and move on.
    try {
      const permitted = resolveFilterSetPermittedValues(filterSetId, recordType);
      await connection.run(
        `CREATE OR REPLACE VIEW "${recordType}" AS SELECT * FROM "${recordType}_raw" WHERE ${staticWhereClause(permitted)}`,
      );
    } catch (error) {
      console.log(`Could not scope "${recordType}" -- skipping (fails closed if it existed before): ${error.message}`);
    }
  }

  return { hasSyncedAccess: cached !== null };
}

module.exports = {
  applyFilterScope,
  SCOPED_RECORD_TYPES,
  STATIC_SCOPED_RECORD_TYPES,
};
