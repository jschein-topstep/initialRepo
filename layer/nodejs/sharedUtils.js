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
  console.log("Raw result from", functionName, ":", JSON.stringify(result));

  // Surface logs from called function into caller's log context
  if (result.logs && result.logs.length > 0) {
    result.logs.forEach((entry) => console.log(`[${functionName}] ${entry}`));
  }

  if (result.statusCode !== 200) {
    throw new Error(
      `${functionName} error: status=${result.statusCode} body=${JSON.stringify(result.body)} logs=${JSON.stringify(result.logs)}`,
    );
  }

  return result.body;
}
