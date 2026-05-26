// import-to-dynamo.mjs
import { DynamoDBClient, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { readFileSync } from "fs";

const client = new DynamoDBClient({ region: "us-east-2" });
const TABLE_NAME = "sppErrorCodes";

const items = JSON.parse(readFileSync("./sppErrorCodes.txt", "utf8"));

// BatchWriteItem max 25 items at a time
const chunks = [];
for (let i = 0; i < items.length; i += 25) {
  chunks.push(items.slice(i, i + 25));
}

for (const chunk of chunks) {
  await client.send(new BatchWriteItemCommand({
    RequestItems: {
      [TABLE_NAME]: chunk.map(item => ({
        PutRequest: { Item: marshall(item) }
      }))
    }
  }));
  console.log(`Imported ${chunk.length} items`);
}

console.log("Done");