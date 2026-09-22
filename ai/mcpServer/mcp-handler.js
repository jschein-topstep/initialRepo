const fs = require("fs");
const path = require("path");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");

const { LambdaTransport } = require("./lambda-transport.js");
const { registerTools, setupConnection } = require("./tools.js");
const oauthEndpoints = require("./oauth-endpoints.js");
const { applyFilterScope } = require("./filterScope.js");
const filterCache = require("./filterCache.js");
const sppRestClient = require("./sppRestClient.js");

const timings = {}; // reused/overwritten per tool call, matches index.js's usage

// Same system-prompt content the runAgent path in aiQueryReports/index.js
// uses, surfaced here as the MCP server's "instructions" field (the closest
// MCP equivalent -- there's no way to force a system prompt on a claude.ai
// conversation the way a direct Anthropic API call can).
const AGENT_INSTRUCTIONS = fs.readFileSync(
  path.join(__dirname, "agent-instructions.txt"),
  "utf8",
);

// Appended rather than folded into agent-instructions.txt itself, because
// that file is shared with the older aiFrontEnd.html/runAgent path, which
// has no SPP-connection concept and none of the tools mentioned below --
// mixing this in there would just be confusing, irrelevant noise for that
// consumer.
const MCP_SPECIFIC_INSTRUCTIONS = `
## SPP account connection status

This connector being reachable (e.g. get_spp_schemas succeeding) tells you
NOTHING about whether the user's own SPP account is connected -- those are
two completely different things. The Projects and Users tables are scoped
per-person to that specific user's SPP access, separately from whether the
tool connection itself works.

- NEVER tell the user their SPP account is "connected" based on
  get_spp_schemas, execute_spp_query succeeding, or any other tool working
  normally. The only way to know their actual connection/sync status is to
  call check_spp_access_status.
- If asked "am I connected to SPP" or anything similar, call
  check_spp_access_status and answer from its result -- do not infer this
  from anything else.
- If a Projects or Users query comes back empty (or execute_spp_query's
  result includes a "note" about this), do not guess at a permissions bug
  or a restrictive filter set -- call check_spp_access_status first. The
  overwhelmingly common cause is simply that the account isn't connected or
  hasn't synced yet.
`;

const FULL_INSTRUCTIONS = `${AGENT_INSTRUCTIONS}\n${MCP_SPECIFIC_INSTRUCTIONS}`;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function handleMcpRequest(event) {
  let message;
  try {
    message = JSON.parse(event.body || "{}");
  } catch {
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  // JSON-RPC batching was removed from the current Streamable HTTP
  // transport spec -- reject arrays outright rather than pretending to
  // support them.
  if (Array.isArray(message)) {
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batched requests are not supported" },
    });
  }

  const toolName = message.method === "tools/call" ? message.params?.name : undefined;
  console.log(`MCP method: ${message.method}${toolName ? ` (tool: ${toolName})` : ""}`);

  const region = process.env.AWS_REGION || "us-east-2";
  const connection = await setupConnection(region, timings);

  // Every request re-scopes "projects"/"users" to the caller's own cached
  // SPP access before any tool runs -- see filterScope.js for why this has
  // to happen every request rather than once per warm container.
  //
  // Claude.ai sends Cognito's ACCESS token as the bearer token, not the ID
  // token -- confirmed via claims logging ("token_use":"access"). Access
  // tokens never carry an "email" claim (that's ID-token-only, per OIDC);
  // they carry "username" instead, which for every user in this pool IS
  // their email (accounts are created with username=email -- see
  // sppUserAuth.js's perUserIntegrationKey). Falling back to claims.email
  // costs nothing if a future token type does carry it.
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const email = claims?.email || claims?.username;
  if (!email) {
    console.log("No email/username claim on this request. Full claims:", JSON.stringify(claims));
  }
  const { hasSyncedAccess } = await applyFilterScope(connection, email);

  const server = new McpServer(
    { name: "spp-data", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: FULL_INSTRUCTIONS,
    },
  );
  registerTools(server, connection, timings, email, hasSyncedAccess);

  const transport = new LambdaTransport();
  await server.connect(transport);

  const response = await transport.handle(message);

  await server.close();

  if (response === undefined) {
    // A notification (e.g. notifications/initialized) -- no JSON-RPC
    // response body is expected.
    return { statusCode: 202, body: "" };
  }

  return json(200, response);
}

// Invoked on a schedule (EventBridge rule, see mcp-server-infra.yaml) with
// {"action": "refreshFilterCache"} -- not an HTTP request at all, so this
// branches before any of the HTTP-specific parsing below. Refreshes the
// cached permitted-ID lists for every person who has connected their SPP
// account, so query-time view scoping (filterScope.js) reads fresh data
// without needing a live SPP round-trip per question.
async function handleRefreshFilterCache() {
  const emails = await filterCache.listConnectedEmails();
  console.log(`Refreshing SPP filter cache for ${emails.length} connected user(s).`);

  const results = await Promise.allSettled(
    emails.map(async (email) => {
      const ids = await sppRestClient.fetchPermittedIdsForUser(email);
      if (!ids) return; // token disappeared between listing and fetching
      await filterCache.savePermittedIds(email, ids);
    }),
  );

  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    console.error(
      `${failures.length} of ${emails.length} filter cache refreshes failed:`,
      failures.map((f) => f.reason?.message),
    );
  }

  return { statusCode: 200, body: JSON.stringify({ refreshed: emails.length, failed: failures.length }) };
}

exports.handler = async (event) => {
  if (event.action === "refreshFilterCache") {
    return await handleRefreshFilterCache();
  }

  const method = event.requestContext?.http?.method;
  const rawPath = event.rawPath || "/";

  console.log(`Request: ${method} ${rawPath}`);

  try {
    if (method === "GET" && rawPath === "/.well-known/oauth-protected-resource") {
      return oauthEndpoints.protectedResourceMetadata();
    }

    if (method === "GET" && rawPath === "/.well-known/oauth-authorization-server") {
      return oauthEndpoints.authorizationServerMetadata();
    }

    if (method === "POST" && rawPath === "/register") {
      return oauthEndpoints.registerClient(event.body);
    }

    if (rawPath === "/mcp") {
      if (method === "POST") {
        return await handleMcpRequest(event);
      }
      // No server-initiated messages (no sampling, no resource-update
      // notifications) and no session tracking -- GET (SSE stream) and
      // DELETE (session termination) are both optional per spec, and both
      // declined here.
      return { statusCode: 405, body: "" };
    }

    if (method === "GET" && rawPath === "/") {
      return json(200, { status: "ok", service: "spp-data MCP server" });
    }

    return json(404, { error: "Not found" });
  } catch (error) {
    console.error("Handler error:", error);
    return json(500, { error: error.message });
  }
};
