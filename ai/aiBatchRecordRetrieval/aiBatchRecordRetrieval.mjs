import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_MAP = {
  "spp-customers": { tableName: "spp-customers", keyType: "string" },
  "spp-users": { tableName: "spp-users", keyType: "string" },
  "spp-projectStages": { tableName: "spp-projectStages", keyType: "string" },
};

// DynamoDB BatchGetItem caps at 100 keys per table per request
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const handler = async (event) => {
  try {
    const { references } = event;
    console.log(`event: ${JSON.stringify(event)}`);

    if (!Array.isArray(references) || references.length === 0) {
      return {
        statusCode: 400,
        body: { error: "references array is required" },
      };
    }

    // group by table, dedupe ids within each table
    const byTable = {};
    for (const ref of references) {
      const config = TABLE_MAP[ref.table];
      if (!config) {
        return {
          statusCode: 400,
          body: {
            error: `Unknown table "${ref.table}". Valid: ${Object.keys(TABLE_MAP).join(", ")}`,
          },
        };
      }
      if (!byTable[ref.table]) byTable[ref.table] = new Set();
      const id = config.keyType === "number" ? Number(ref.id) : String(ref.id);
      byTable[ref.table].add(id);
    }

    const resolved = [];

    for (const [tableKey, idSet] of Object.entries(byTable)) {
      const { tableName } = TABLE_MAP[tableKey];
      const ids = [...idSet];
      const batches = chunk(ids, 100);

      for (const batch of batches) {
        const result = await docClient.send(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: {
                Keys: batch.map((id) => ({ id })),
              },
            },
          }),
        );

        const items = result.Responses?.[tableName] || [];
        for (const item of items) {
          resolved.push({
            table: tableKey,
            id: item.id,
            name: item.name || null, // adjust field name once confirmed
          });
        }

        // NOTE: not handling UnprocessedKeys retry here — add if you see
        // partial results under load
      }
    }

    return {
      statusCode: 200,
      body: { references: resolved },
    };
  } catch (err) {
    console.error("resolveReferences error:", err);
    return { statusCode: 500, body: { error: err.message } };
  }
};

async function test() {
  const result = await handler({
    references: [
      {
        table: "spp-customers",
        id: "4471",
      },
      {
        table: "spp-users",
        id: "112",
      },
      {
        table: "spp-projectStages",
        id: "3",
      },
    ],
  });

  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
