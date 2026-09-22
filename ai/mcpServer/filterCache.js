// Reads/writes the cached per-user permitted-ID lists (sppFilterCache
// table), populated by the scheduled refresh (see mcp-handler.js's
// "refreshFilterCache" action) from sppRestClient.js.

const { DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamo = new DynamoDBClient({});
const FILTER_CACHE_TABLE = process.env.FILTER_CACHE_TABLE;

async function getCachedPermittedIds(email) {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: FILTER_CACHE_TABLE,
      Key: marshall({ email: email.toLowerCase().trim() }),
    }),
  );
  return result.Item ? unmarshall(result.Item) : null;
}

async function savePermittedIds(email, idsByRecordType) {
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new PutItemCommand({
      TableName: FILTER_CACHE_TABLE,
      Item: marshall(
        { email: email.toLowerCase().trim(), ...idsByRecordType, updatedAt: now },
        { removeUndefinedValues: true },
      ),
    }),
  );
}

// Every connected person's email -- derived from oauth_tokens rows whose pk
// matches the per-user key convention in sppUserAuth.js. Used by the
// scheduled refresh to know who to fetch fresh IDs for.
async function listConnectedEmails() {
  const OAUTH_TOKENS_TABLE = process.env.OAUTH_TOKENS_TABLE || "oauth_tokens";
  const PREFIX = "spp-top-step-user-";

  const emails = [];
  let lastKey;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: OAUTH_TOKENS_TABLE,
        ProjectionExpression: "pk",
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const pk = unmarshall(item).pk;
      if (pk?.startsWith(PREFIX)) {
        emails.push(pk.slice(PREFIX.length));
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return emails;
}

module.exports = { getCachedPermittedIds, savePermittedIds, listConnectedEmails };
