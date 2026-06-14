/**
 * oauthUtils.mjs
 *
 * Shared OAuth2 utility for Lambda functions.
 *
 * Primary export: getValidAccessToken(integrationKey)
 *   - Reads tokens from oauth_tokens
 *   - Auto-refreshes if expired (or within EXPIRY_BUFFER_SECONDS)
 *   - Returns a valid access_token string
 *
 * Other exports used by the OAuth Lambda functions themselves.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
});

const CONFIG_TABLE = process.env.OAUTH_CONFIG_TABLE || "oauth_config";
const TOKENS_TABLE = process.env.OAUTH_TOKENS_TABLE || "oauth_tokens";

/** Refresh this many seconds before actual expiry to avoid edge-case 401s */
const EXPIRY_BUFFER_SECONDS = 60;

// ─────────────────────────────────────────────
// DynamoDB helpers
// ─────────────────────────────────────────────

/**
 * Read a row from oauth_config.
 * @param {string} integrationKey  e.g. "spp"
 * @returns {object} config row
 */
export async function getOAuthConfig(integrationKey) {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: CONFIG_TABLE,
      Key: marshall({ pk: integrationKey }),
    }),
  );

  if (!res.Item) {
    throw new Error(`No oauth_config found for key: ${integrationKey}`);
  }
  return unmarshall(res.Item);
}

/**
 * Read a row from oauth_tokens.
 * @param {string} integrationKey
 * @returns {object|null}
 */
export async function getStoredTokens(integrationKey) {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: TOKENS_TABLE,
      Key: marshall({ pk: integrationKey }),
    }),
  );
  return res.Item ? unmarshall(res.Item) : null;
}

/**
 * Persist tokens to oauth_tokens.
 * @param {string} integrationKey
 * @param {object} tokenData  { access_token, refresh_token, expires_in, token_type, scope }
 */
export async function saveTokens(integrationKey, tokenData) {
  const now = Math.floor(Date.now() / 1000); // epoch seconds
  const expiresAt = now + (tokenData.expires_in || 3600);

  const item = {
    pk: integrationKey,
    access_token: tokenData.access_token,
    token_type: tokenData.token_type || "Bearer",
    scope: tokenData.scope || "",
    expires_at: expiresAt,
    // DynamoDB TTL — auto-delete row a day after expiry (optional safety net)
    //ttl:           expiresAt + 86400,
  };

  // Only overwrite refresh_token if the provider returned a new one
  // (some providers rotate; others return the same one; some omit it on refresh)
  if (tokenData.refresh_token) {
    item.refresh_token = tokenData.refresh_token;
  } else {
    // Preserve the existing refresh_token if present
    const existing = await getStoredTokens(integrationKey);
    if (existing?.refresh_token) {
      item.refresh_token = existing.refresh_token;
    }
  }

  await dynamo.send(
    new PutItemCommand({
      TableName: TOKENS_TABLE,
      Item: marshall(item),
    }),
  );

  return item;
}

// ─────────────────────────────────────────────
// Token refresh
// ─────────────────────────────────────────────

/**
 * Exchange a refresh_token for a new access_token.
 * Saves the result to oauth_tokens and returns it.
 * @param {string} integrationKey
 * @returns {object} saved token row
 */
export async function refreshTokens(integrationKey) {
  const [config, stored] = await Promise.all([
    getOAuthConfig(integrationKey),
    getStoredTokens(integrationKey),
  ]);

  if (!stored?.refresh_token) {
    throw new Error(
      `No refresh_token stored for: ${integrationKey}. Full re-authorization required.`,
    );
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: config.client_id,
    client_secret: config.client_secret,
  });

  const response = await fetch(config.token_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed [${response.status}]: ${errorText}`);
  }

  const tokenData = await response.json();
  return saveTokens(integrationKey, tokenData);
}

// ─────────────────────────────────────────────
// Main export — use this in your SPP functions
// ─────────────────────────────────────────────

/**
 * Returns a valid access_token for the given integration,
 * refreshing automatically if expired or about to expire.
 *
 * Usage in any Lambda:
 *   import { getValidAccessToken } from "/opt/nodejs/oauthUtils.mjs";
 *   const token = await getValidAccessToken("spp");
 *   // use token in Authorization: Bearer <token> header
 *
 * @param {string} integrationKey
 * @returns {string} access_token
 */
export async function getValidAccessToken(integrationKey) {
  const stored = await getStoredTokens(integrationKey);

  if (!stored?.access_token) {
    throw new Error(
      `No tokens stored for: ${integrationKey}. Authorization required.`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const isExpired = stored.expires_at <= now + EXPIRY_BUFFER_SECONDS;

  if (isExpired) {
    console.log(
      `[oauthUtils] Token for "${integrationKey}" expired or near expiry — refreshing.`,
    );
    const refreshed = await refreshTokens(integrationKey);
    return refreshed.access_token;
  }

  return stored.access_token;
}
