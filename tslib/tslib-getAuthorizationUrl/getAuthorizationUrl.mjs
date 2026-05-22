/**
 * getAuthorizationUrl/index.mjs
 *
 * Lambda function: builds and returns the OAuth2 authorization URL.
 *
 * Invoke this to kick off the OAuth flow. The returned URL should be
 * opened in a browser (by a user or an admin during initial setup).
 *
 * Event input:
 *   { "integrationKey": "spp" }
 *
 * Response:
 *   { "authorizationUrl": "https://...", "state": "abc123" }
 */

import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { getOAuthConfig } from "/opt/nodejs/oauthUtils.mjs";
import { randomBytes } from "crypto";

const dynamo = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
});
const CONFIG_TABLE = process.env.OAUTH_CONFIG_TABLE || "oauth_config";

export const handler = async (event) => {
  try {
    const integrationKey =
      event.integrationKey || event.queryStringParameters?.integrationKey;

    if (!integrationKey) {
      return response(400, { error: "integrationKey is required" });
    }

    const config = await getOAuthConfig(integrationKey);

    // Generate a cryptographically random state value for CSRF protection
    const state = `${integrationKey}:${randomBytes(16).toString("hex")}`;

    // Persist state to oauth_config so exchangeCodeForTokens can verify it
    await dynamo.send(
      new UpdateItemCommand({
        TableName: CONFIG_TABLE,
        Key: marshall({ pk: integrationKey }),
        UpdateExpression: "SET #state = :state",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: marshall({ ":state": state }),
      }),
    );

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.client_id,
      redirect_uri: config.redirect_uri,
      scope: config.scope,
      state,
    });

    const authorizationUrl = `${config.authorization_url}?${params.toString()}`;

    console.log(`[getAuthorizationUrl] Built auth URL for "${integrationKey}"`);

    return response(200, { authorizationUrl, state });
  } catch (err) {
    console.error("[getAuthorizationUrl] Error:", err);
    return response(500, { error: err.message });
  }
};

const response = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
