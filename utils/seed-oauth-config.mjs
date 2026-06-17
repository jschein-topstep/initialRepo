/**
 * seed-oauth-config.mjs
 *
 * Run once (or via a secure admin Lambda) to populate oauth_config
 * with the details for an integration.
 *
 * Usage:
 *   node seed-oauth-config.mjs
 *
 * Set env vars before running:
 *   AWS_PROFILE, AWS_REGION, and the values below.
 */

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";

const client = new DynamoDBClient({ region: "us-east-2" });

const config = {
  pk: "spp-paladin-sb", // integration key — matches oauth_tokens pk
  client_id: "83547_kd3P1hCegALfrjPw",
  client_secret:
    "J-oMxcYRvyBbIEqIs6tlKs4E2zo-zBwW9N9wgUEFRCMP6eQa0v_3aXUh-dkhoaHDITWkaETd33Al0XNgIcl1qw", // or store SSM param name here instead
  redirect_uri:
    "https://q44gc4muxql4xf2iw74ptsvnp40lhwyd.lambda-url.us-east-2.on.aws/", // tslib-exchangeCodeForTokens
  scope: "xml", // space-separated
  authorization_url:
    "https://11593134-paladin-management-group.app.sandbox.netsuitesuiteprojectspro.com/login/oauth2/v1/authorize", // e.g. https://auth.example.com/oauth2/authorize
  token_url:
    "https://11593134-paladin-management-group.app.sandbox.netsuitesuiteprojectspro.com/login/oauth2/v1/token", // e.g. https://auth.example.com/oauth2/token
  // state is typically generated at runtime, but you can seed a default here
  // state: "some-random-value"
};

await client.send(
  new PutItemCommand({
    TableName: "oauth_config",
    Item: marshall(config),
  }),
);

console.log(`Seeded oauth_config for pk="${config.pk}"`);
