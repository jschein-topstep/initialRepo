import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION || "us-east-2",
});

export async function callSharedUtil(functionName, payload = {}, retries = 3, retryDelayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: JSON.stringify(payload),
      }),
    );
    const result = JSON.parse(Buffer.from(response.Payload).toString());

    // Lambda-level error (function crashed before handler ran)
    if (result.errorType) {
      console.log(
        `[${functionName}] Lambda error: ${result.errorType}: ${result.errorMessage}`,
      );
      throw new Error(
        `${functionName} Lambda error: ${result.errorType}: ${result.errorMessage}`,
      );
    }

    // Surface logs from called function into caller's log context
    if (result.logs && result.logs.length > 0) {
      result.logs.forEach((entry) => console.log(`[${functionName}] ${entry}`));
    }

    if (result.statusCode !== 200) {
      if (attempt < retries) {
        console.log(`[${functionName}] status=${result.statusCode} on attempt ${attempt}, retrying in ${retryDelayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        retryDelayMs *= 2;
        continue;
      }
      throw new Error(
        `${functionName} error: status=${result.statusCode} body=${JSON.stringify(result.body)} logs=${JSON.stringify(result.logs)}`,
      );
    }

    return result.body;
  }
}
