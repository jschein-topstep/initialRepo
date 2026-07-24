import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = "spp-transaction-summary";

function buildSkRange({ type, year, month, quarter }) {
  // same logic as your existing preLookup / Get Transactions sk-building
  const pad = (n) => String(n).padStart(2, "0");
  let sk1, sk2;
  if (month) {
    const next = month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
    sk1 = `${type}#${year}-${pad(month)}`;
    sk2 = `${type}#${next}`;
  } else if (quarter) {
    const starts = { 1: 1, 2: 4, 3: 7, 4: 10 };
    const startMonth = starts[quarter];
    const endMonthExclusive = startMonth + 3;
    const endYear = endMonthExclusive > 12 ? year + 1 : year;
    const endMonth =
      endMonthExclusive > 12 ? endMonthExclusive - 12 : endMonthExclusive;
    sk1 = `${type}#${year}-${pad(startMonth)}`;
    sk2 = `${type}#${endYear}-${pad(endMonth)}`;
  } else if (year) {
    sk1 = `${type}#${year}-01`;
    sk2 = `${type}#${year + 1}-01`;
  } else {
    sk1 = `${type}#`;
    sk2 = `${type}#\uffff`;
  }
  return { sk1, sk2 };
}

export const handler = async (event) => {
  try {
    const { projectIds, type, year, month, quarter, action } = JSON.parse(
      event.body,
    );

    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "projectIds array is required" }),
      };
    }

    const { sk1, sk2 } = buildSkRange({ type, year, month, quarter });
    const uniqueIds = [...new Set(projectIds.map(String))];

    // Run queries in parallel — one Query per project, but server-side,
    // not agent tool calls
    const results = await Promise.all(
      uniqueIds.map(async (projectid) => {
        const queryResult = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "#pk = :pk and #sk between :sk1 and :sk2",
            ExpressionAttributeNames: {
              "#pk": "projectId",
              "#sk": "sk",
            },
            ExpressionAttributeValues: {
              ":pk": projectid,
              ":sk1": sk1,
              ":sk2": sk2,
            },
          }),
        );

        const records = queryResult.Items || [];
        const amounts = records.map((r) => parseFloat(r.amount));
        let result;
        if (action === "sum")
          result = amounts.length ? amounts.reduce((a, b) => a + b, 0) : 0;
        else if (action === "min")
          result = amounts.length ? Math.min(...amounts) : null;
        else if (action === "max")
          result = amounts.length ? Math.max(...amounts) : null;

        return { projectid, action, result, recordCount: records.length };
      }),
    );

    return { statusCode: 200, body: JSON.stringify({ results }) };
  } catch (err) {
    console.error("getTransactionsBatch error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
async function test() {
  const result = await handler({
    body: JSON.stringify({
      projectIds: ["1975", "1821", "2471"],
      type: "BOOKING",
      year: 2025,
      action: "sum",
    }),
  });

  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
