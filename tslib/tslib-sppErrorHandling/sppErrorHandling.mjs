import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const dynamo = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-2",
});

export const handler = async (event) => {
  const bodyJSON = JSON.parse(event.errorCode);
  const errCode = bodyJSON;
  const res = await dynamo.send(
    new GetItemCommand({
      TableName: "sppErrorCodes",
      Key: marshall({ errorCode: errCode }),
    }),
  );

  if (!res.Item) {
    throw new Error(`No error found for spp error code: ${event}`);
  }
  console.log(`ErrorItem: ${JSON.stringify(res.Item)}`);
  return unmarshall(res.Item);
};
