/**
 * refreshAccessToken/index.mjs
 *
 * Lambda function: manually triggers a token refresh for an integration.
 *
 * You typically won't need to invoke this directly — getValidAccessToken()
 * in oauthUtils.mjs handles auto-refresh transparently. This function
 * exists for:
 *   - Manual/admin-triggered refreshes
 *   - Scheduled EventBridge rules (proactive refresh before expiry)
 *   - Debugging / testing the refresh flow
 *
 * Event input:
 *   { "integrationKey": "spp" }
 *   OR array for batch refresh:
 *   { "integrationKeys": ["spp", "other_integration"] }
 *
 * Response:
 *   { "results": [{ "integrationKey": "spp", "success": true, "expires_at": 1234567890 }] }
 */

import { refreshTokens } from "/opt/nodejs/oauthUtils.mjs";

export const handler = async (event) => {
  try {
    // Support single key or batch
    const keys = event.integrationKeys
      ?? (event.integrationKey ? [event.integrationKey] : null);

    if (!keys?.length) {
      return response(400, { error: "Provide integrationKey or integrationKeys[]" });
    }

    const results = await Promise.allSettled(
      keys.map(async (integrationKey) => {
        const saved = await refreshTokens(integrationKey);
        console.log(`[refreshAccessToken] Refreshed tokens for "${integrationKey}", expires_at=${saved.expires_at}`);
        return { integrationKey, success: true, expires_at: saved.expires_at };
      })
    );

    const formatted = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { integrationKey: keys[i], success: false, error: r.reason?.message }
    );

    const allOk = formatted.every((r) => r.success);

    return response(allOk ? 200 : 207, { results: formatted });

  } catch (err) {
    console.error("[refreshAccessToken] Unexpected error:", err);
    return response(500, { error: err.message });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
