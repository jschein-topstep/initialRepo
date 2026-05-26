import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
});

export async function getError(errorCode) {
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: sppErrorCodes,
      Key: marshall({ pk: errorCode }),
    }),
  );

  if (!res.Item) {
    throw new Error(`No error found for spp err code: ${errorCode}`);
  }
  return unmarshall(res.Item);
}
