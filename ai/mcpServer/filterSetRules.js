// Translates SPP "filter set" metavalue IDs (the negative IDs returned by
// <Read type="Filter" method="all">, e.g. -3 = "Access to owned Projects")
// into SQL subqueries selecting the permitted row IDs for the CURRENT
// authenticated user, using data already materialized locally. This module
// does NOT call SPP itself -- it only translates an already-fetched Filter
// Read result (literal positive IDs + negative metavalue IDs) into SQL. The
// live per-user SPP call is a separate, not-yet-built piece (blocked on
// confirming whether the Filter object's "type" attribute actually supports
// values other than "customer" -- the XML guide excerpt we have says
// otherwise, which needs resolving before that piece can be built).
//
// NOT WIRED IN YET. Nothing in the live MCP server (mcp-handler.js,
// tools.js) references this file -- it's standalone until the real
// enforcement hookup happens, which will also need to settle how the
// unfiltered base tables get named once per-request scoped views sit in
// front of them (that's an index.js change, deliberately deferred).
//
// An unsupported/not-yet-implemented metavalue (no resolver below, or
// blocked on data we don't load yet -- project_task_assign, hierarchy node)
// is represented as `null` and MUST be treated as "contributes zero
// additional rows" by callers -- fail closed, never fail open. Getting this
// backwards (silently ignoring a restriction) is a data leak, not a bug.

function assertSafeUserId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid user id for filter-set resolution: ${id}`);
  }
  return id;
}

// --- Projects ---------------------------------------------------------------

const PROJECT_RESOLVERS = {
  // -3: Access to owned Projects
  "-3": (me) => `SELECT id FROM projects WHERE user_id = ${me}`,

  // -1: Access to booked Projects
  "-1": (me) =>
    `SELECT DISTINCT project_id AS id FROM booking WHERE user_id = ${me}`,

  // -24: Access to managed users' recorded time against Projects
  "-24": (me) => `
    SELECT DISTINCT te.project_id AS id
    FROM timeEntries te
    JOIN users u ON te.user_id = u.id
    WHERE u.line_manager_id = ${me}
  `,

  // -23: Access to managed users' booked Projects
  "-23": (me) => `
    SELECT DISTINCT b.project_id AS id
    FROM booking b
    JOIN users u ON b.user_id = u.id
    WHERE u.line_manager_id = ${me}
  `,

  // -2: Access to assigned Projects -- BLOCKED. Requires project_task_assign,
  // not yet in the S3 export pipeline.
  "-2": null,

  // -15: Access to managed users' assigned Projects -- same blocker as -2.
  "-15": null,

  // -19: Access to Projects in my hierarchy node -- BLOCKED. Hierarchy node
  // not yet loaded on either projects or users.
  "-19": null,
};

// --- Users --------------------------------------------------------------------

const USER_RESOLVERS = {
  // -4: Myself
  "-4": (me) => `SELECT ${me} AS id`,

  // -6: Access to managed Users (direct reports)
  "-6": (me) => `SELECT id FROM users WHERE line_manager_id = ${me}`,

  // -8: Access to peer Users (share my manager, excluding myself)
  "-8": (me) => `
    SELECT id FROM users
    WHERE line_manager_id = (SELECT line_manager_id FROM users WHERE id = ${me})
      AND id != ${me}
  `,

  // -9: Access to manager
  "-9": (me) => `SELECT line_manager_id AS id FROM users WHERE id = ${me}`,

  // -10: Access to manager's manager
  "-10": (me) => `
    SELECT line_manager_id AS id FROM users
    WHERE id = (SELECT line_manager_id FROM users WHERE id = ${me})
  `,

  // -12: Access to manager's manager's direct reports
  "-12": (me) => `
    SELECT id FROM users
    WHERE line_manager_id = (
      SELECT line_manager_id FROM users
      WHERE id = (SELECT line_manager_id FROM users WHERE id = ${me})
    )
  `,

  // -11: Access to direct reports and below (recursive)
  "-11": (me) => `
    WITH RECURSIVE subtree AS (
      SELECT id FROM users WHERE line_manager_id = ${me}
      UNION ALL
      SELECT u.id FROM users u JOIN subtree s ON u.line_manager_id = s.id
    )
    SELECT id FROM subtree
  `,

  // -14: Access to manager's direct reports and below (recursive, rooted at
  // my manager rather than me)
  "-14": (me) => `
    WITH RECURSIVE subtree AS (
      SELECT id FROM users
      WHERE line_manager_id = (SELECT line_manager_id FROM users WHERE id = ${me})
      UNION ALL
      SELECT u.id FROM users u JOIN subtree s ON u.line_manager_id = s.id
    )
    SELECT id FROM subtree
  `,

  // -13: Access to manager's manager's direct reports' direct reports and
  // below (recursive, rooted at the set of manager's-manager's direct
  // reports)
  "-13": (me) => `
    WITH RECURSIVE roots AS (
      SELECT id FROM users
      WHERE line_manager_id = (
        SELECT line_manager_id FROM users
        WHERE id = (SELECT line_manager_id FROM users WHERE id = ${me})
      )
    ),
    subtree AS (
      SELECT id FROM roots
      UNION ALL
      SELECT u.id FROM users u JOIN subtree s ON u.line_manager_id = s.id
    )
    SELECT id FROM subtree
  `,

  // -18: Access to Users booked to my owned projects
  "-18": (me) => `
    SELECT DISTINCT b.user_id AS id
    FROM booking b
    JOIN projects p ON b.project_id = p.id
    WHERE p.user_id = ${me}
  `,

  // -16: Access to Users assigned to my owned projects -- BLOCKED. Requires
  // project_task_assign.
  "-16": null,

  // -22: Access to project owners in my hierarchy node -- BLOCKED. Hierarchy
  // node not yet loaded.
  "-22": null,

  // -21: Access to Users assigned to my hierarchy node -- BLOCKED, same as
  // -22. Also unconfirmed: whether "assigned" here means a direct
  // users.hierarchy_node_id match or something routed through project
  // assignment -- resolve once hierarchy node data actually lands.
  "-21": null,

  // -20: Access to Users booked to my hierarchy node -- BLOCKED. Hierarchy
  // node not yet loaded.
  "-20": null,
};

const RESOLVERS_BY_RECORD_TYPE = {
  projects: PROJECT_RESOLVERS,
  users: USER_RESOLVERS,
};

// Returns a SQL subquery (a `SELECT id FROM (...)` shaped fragment)
// selecting every row ID the given user is permitted to see for
// recordType, from their already-fetched Filter Read result.
//
// literalIds: positive integer IDs (specific records) from that result.
// metavalueIds: negative integer IDs (rule tokens, e.g. -3) from the same
// result. IDs 0 and 1 should already have been dropped by the caller (per
// the XML guide: "should be ignored").
function buildPermittedIdsSubquery(recordType, meUserId, literalIds, metavalueIds) {
  const me = assertSafeUserId(meUserId);
  const resolvers = RESOLVERS_BY_RECORD_TYPE[recordType];
  if (!resolvers) {
    throw new Error(`No filter-set resolvers defined for record type "${recordType}"`);
  }

  const parts = [];

  const safeLiteralIds = (literalIds ?? []).filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (safeLiteralIds.length > 0) {
    parts.push(`SELECT UNNEST([${safeLiteralIds.join(", ")}]) AS id`);
  }

  for (const metaId of metavalueIds ?? []) {
    const resolver = resolvers[String(metaId)];
    if (typeof resolver === "function") {
      parts.push(resolver(me));
    }
    // else: unsupported/blocked metavalue -- contributes nothing, on purpose.
  }

  if (parts.length === 0) {
    // No usable rule at all -- permit nothing rather than everything.
    return "SELECT NULL AS id WHERE FALSE";
  }

  return parts.join("\nUNION\n");
}

module.exports = {
  buildPermittedIdsSubquery,
  RESOLVERS_BY_RECORD_TYPE,
};
