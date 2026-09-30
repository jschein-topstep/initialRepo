// OAuth discovery + Dynamic Client Registration (DCR) shim.
//
// Token issuance itself is handled entirely by Cognito's real Hosted UI
// (authorization_endpoint/token_endpoint below point straight at Cognito,
// and API Gateway's JWT authorizer validates the resulting tokens against
// Cognito directly -- this Lambda never sees a password or issues a token
// itself). The only gap this fills is that Cognito has no Dynamic Client
// Registration support (RFC 7591), which MCP clients expect to be able to
// call before starting the OAuth flow. Since there is really only ever one
// real caller here (Claude), /register doesn't create anything new -- it
// just hands back the one pre-created Cognito App Client's client_id in the
// shape a DCR response is expected to have. The actual security boundary is
// Cognito's own App Client callback-URL allow-list, not this endpoint.
const COGNITO_ISSUER = process.env.COGNITO_ISSUER;
const COGNITO_AUTHORIZATION_ENDPOINT = process.env.COGNITO_AUTHORIZATION_ENDPOINT;
const COGNITO_TOKEN_ENDPOINT = process.env.COGNITO_TOKEN_ENDPOINT;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const MCP_SERVER_BASE_URL = process.env.MCP_SERVER_BASE_URL;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Discovered first, either directly or via the WWW-Authenticate header on an
// unauthenticated 401 from /mcp. Points clients at the authorization
// server(s) that protect this resource.
function protectedResourceMetadata() {
  return json(200, {
    resource: `${MCP_SERVER_BASE_URL}/mcp`,
    authorization_servers: [MCP_SERVER_BASE_URL],
  });
}

// This is OUR metadata document, not Cognito's -- it re-exports Cognito's
// real authorization/token endpoints (so tokens really are issued by
// Cognito, with Cognito's real "iss" claim) while adding the one field
// Cognito's own metadata lacks: registration_endpoint.
function authorizationServerMetadata() {
  return json(200, {
    issuer: COGNITO_ISSUER,
    authorization_endpoint: COGNITO_AUTHORIZATION_ENDPOINT,
    token_endpoint: COGNITO_TOKEN_ENDPOINT,
    registration_endpoint: `${MCP_SERVER_BASE_URL}/register`,
    jwks_uri: `${COGNITO_ISSUER}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "email"],
  });
}

function registerClient(body) {
  let parsed = {};
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    // Tolerate a malformed body -- we're not actually creating anything
    // from it, just echoing back the one real client_id below.
  }

  console.log("DCR request:", JSON.stringify(parsed));

  const now = Math.floor(Date.now() / 1000);

  return json(201, {
    client_id: COGNITO_CLIENT_ID,
    client_id_issued_at: now,
    redirect_uris: parsed.redirect_uris ?? [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
}

module.exports = {
  protectedResourceMetadata,
  authorizationServerMetadata,
  registerClient,
};
