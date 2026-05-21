import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION || "us-east-2",
});

export async function callSharedUtil(functionName, payload = {}) {
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify(payload),
    }),
  );
  const result = JSON.parse(Buffer.from(response.Payload).toString());

  console.log("statusCode:", result.statusCode);
  console.log("body:", JSON.stringify(result.body));
  console.log("body type:", typeof result.body);

  if (result.statusCode !== 200) {
    throw new Error(`${functionName} error: ${JSON.stringify(result.body)}`);
  }

  return result.body;
}
