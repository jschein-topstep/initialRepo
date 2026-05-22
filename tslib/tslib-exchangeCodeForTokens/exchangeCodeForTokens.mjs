/**
 * exchangeCodeForTokens/index.mjs
 *
 * Lambda function: handles the OAuth2 redirect callback.
 * Exchanges the authorization code for access + refresh tokens
 * and persists them to oauth_tokens.
 *
 * Wire this to API Gateway:
 *   GET /oauth/callback?code=...&state=...&integrationKey=spp
 *
 * The integrationKey can be passed as:
 *   - A query param: ?integrationKey=spp
 *   - Encoded in the state value: state = "spp:abc123"  (see note below)
 *
 * Response (success):
 *   Redirects to OAUTH_SUCCESS_REDIRECT_URI env var, or returns JSON.
 */

import { getOAuthConfig, saveTokens } from "/opt/nodejs/oauthUtils.mjs";

export const handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const { code, state, error, error_description } = qs;

    // The auth server may return an error instead of a code
    if (error) {
      console.error(`[exchangeCodeForTokens] Auth server error: ${error} — ${error_description}`);
      return response(400, { error, error_description });
    }

    if (!code) {
      return response(400, { error: "Missing authorization code" });
    }

    // ── Resolve integrationKey ──────────────────────────────────────────
    // Option A: passed explicitly as a query param
    // Option B: encoded as the prefix of state ("spp:abc123")
    //   — useful if your auth server doesn't support extra query params
    let integrationKey = qs.integrationKey;
    let expectedState  = state;

    if (!integrationKey && state?.includes(":")) {
      [integrationKey, expectedState] = state.split(":", 2);
    }

    if (!integrationKey) {
      return response(400, { error: "Cannot determine integrationKey from request" });
    }

    // ── State verification (CSRF protection) ───────────────────────────
    const config = await getOAuthConfig(integrationKey);

    if (config.state && config.state !== expectedState) {
      console.error(`[exchangeCodeForTokens] State mismatch for "${integrationKey}"`);
      return response(400, { error: "State mismatch — possible CSRF attempt" });
    }

    // ── Exchange code for tokens ────────────────────────────────────────
    const params = new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri:  config.redirect_uri,
      client_id:     config.client_id,
      client_secret: config.client_secret,
    });

    const tokenResponse = await fetch(config.token_url, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    params.toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`Token exchange failed [${tokenResponse.status}]: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    await saveTokens(integrationKey, tokenData);

    console.log(`[exchangeCodeForTokens] Tokens saved for "${integrationKey}"`);

    // ── Respond ─────────────────────────────────────────────────────────
    const successRedirect = process.env.OAUTH_SUCCESS_REDIRECT_URI;

    if (successRedirect) {
      return {
        statusCode: 302,
        headers: { Location: successRedirect },
        body: "",
      };
    }

    return response(200, {
      message: `Authorization complete for "${integrationKey}"`,
      token_type: tokenData.token_type,
      scope:      tokenData.scope,
      expires_in: tokenData.expires_in,
    });

  } catch (err) {
    console.error("[exchangeCodeForTokens] Error:", err);
    return response(500, { error: err.message });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
