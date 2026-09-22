import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import crypto from "node:crypto";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const lambdaClient = new LambdaClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE;
const TERMS_TABLE = process.env.TERMS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;
const AGENT_FUNCTION_NAME = process.env.AGENT_FUNCTION_NAME;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;

const MAX_TURNS = 4;
const CONVERSATION_IDLE_SECONDS = 4 * 60 * 60; // slides forward on each turn
const DEFINITIONS_CACHE_SECONDS = 60; // avoid a Scan on every single question

const DEFAULT_TIMEZONE = "America/New_York";

// Computes today's date, formatted for the prompt, in a specific timezone --
// so the agent can correctly reason about relative date phrases ("this
// year," "last quarter," "year to date") from the asker's actual point of
// view, not the Lambda's server clock (which is UTC and would silently
// report the wrong calendar day for a chunk of every US business day).
// The browser supplies its own IANA timezone (e.g. "America/Chicago") with
// every question. If it's missing or isn't a real IANA identifier,
// Intl.DateTimeFormat throws immediately when constructed -- caught here
// and treated as a fallback to a fixed default rather than crashing the
// request over a formatting detail.
function formatTodayForTimezone(timezone) {
  let tz =
    typeof timezone === "string" && timezone.trim()
      ? timezone.trim()
      : DEFAULT_TIMEZONE;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return `${formatter.format(new Date())} (${tz})`;
  } catch {
    // Not a valid IANA timezone identifier -- fall back rather than fail.
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TIMEZONE,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    return `${formatter.format(new Date())} (${DEFAULT_TIMEZONE}, fallback -- "${timezone}" was not a recognized timezone)`;
  }
}

export const handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method;

    if (method === "POST") {
      const body = parseBody(event.body);

      if (body.action === "complete") {
        return await completeRequest(body);
      }

      if (body.action === "fail") {
        return await failRequest(body);
      }

      if (body.action === "saveDefinition") {
        return await saveDefinition(body);
      }

      if (body.action === "deleteDefinition") {
        return await deleteDefinition(body);
      }

      if (body.action === "login") {
        return await login(body);
      }

      if (body.action === "changePassword") {
        return await changePassword(body);
      }

      return await submitQuestion(body);
    }

    if (method === "GET") {
      const query = event.queryStringParameters ?? {};

      if (query.action === "definitions") {
        return await listDefinitions();
      }

      return await getStatus(query);
    }

    return json(405, {
      error: "Method not allowed",
    });
  } catch (error) {
    console.error("Unhandled error:", error);

    return json(500, {
      error: "An unexpected error occurred",
    });
  }
};

/**
 * Page-gate login for the S3 front end. This is deliberately lightweight --
 * a plaintext username/password lookup with no session token or per-request
 * enforcement on any other action. It exists to keep casual/accidental
 * visitors out of the UI, not to secure the Lambda Function URL itself
 * (which remains reachable by anyone who has it, gate or no gate). Revisit
 * with hashed passwords and real session enforcement if the bar ever needs
 * to move beyond "appearance of security."
 */
async function login(body) {
  const username = body.username?.trim();
  const password = body.password;

  if (!username || !password) {
    return json(400, {
      error: "Username and password are both required",
    });
  }

  if (!USERS_TABLE) {
    console.error("Missing USERS_TABLE");

    return json(500, {
      error: "Lambda configuration is incomplete",
    });
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { username },
    }),
  );

  if (!result.Item || result.Item.password !== password) {
    return json(401, {
      error: "Invalid username or password",
    });
  }

  return json(200, { username });
}

/**
 * Self-service password change. Re-verifies the current password
 * server-side rather than trusting the front end's confirmation check --
 * that's just UX. Same plaintext storage as login().
 */
async function changePassword(body) {
  const username = body.username?.trim();
  const currentPassword = body.currentPassword;
  const newPassword = body.newPassword;

  if (!username || !currentPassword || !newPassword) {
    return json(400, {
      error: "username, currentPassword, and newPassword are all required",
    });
  }

  if (!USERS_TABLE) {
    console.error("Missing USERS_TABLE");

    return json(500, {
      error: "Lambda configuration is incomplete",
    });
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { username },
    }),
  );

  if (!result.Item || result.Item.password !== currentPassword) {
    return json(401, {
      error: "Current password is incorrect",
    });
  }

  await dynamo.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { username },
      UpdateExpression: "SET password = :password",
      ExpressionAttributeValues: {
        ":password": newPassword,
      },
    }),
  );

  return json(200, { username });
}

/**
 * Receives a question from the S3 web page.
 */
async function submitQuestion(body) {
  const question = body.question?.trim();
  const sessionId = body.sessionId?.trim() || null;
  const todayText = formatTodayForTimezone(body.timezone);

  if (!question) {
    return json(400, {
      error: "Question is required",
    });
  }

  if (!TABLE_NAME || !AGENT_FUNCTION_NAME) {
    console.error("Missing TABLE_NAME or AGENT_FUNCTION_NAME");

    return json(500, {
      error: "Lambda configuration is incomplete",
    });
  }

  const requestId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Delete automatically after 24 hours if DynamoDB TTL is enabled on "expiresAt".
  const expiresAt = now + 86400;

  // Definitions get prepended on every call -- they're instance-wide domain
  // knowledge, not conversation history, so a brand-new thread's first
  // question needs them just as much as a follow-up does.
  //
  // Conversation history is reconstructed manually here because each
  // runAgent invocation starts a fresh conversation with the model -- there
  // is no server-side session memory to lean on, so prior turns have to be
  // replayed explicitly every time. The schema-already-fetched reminder is
  // embedded inside buildAugmentedPrompt itself, gated on whether there are
  // any prior turns.
  const conversation = sessionId ? await getConversation(sessionId) : null;
  const definitions = await getDefinitions();
  const augmentedPrompt = buildAugmentedPrompt(
    question,
    definitions,
    conversation,
    todayText,
  );

  await dynamo.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        requestId,
        sessionId,
        question,
        promptSent: augmentedPrompt,
        status: "processing",
        createdAt: now,
        updatedAt: now,
        expiresAt,
      },
      ConditionExpression: "attribute_not_exists(requestId)",
    }),
  );

  try {
    // Fire-and-forget: an async ("Event") invocation just queues the
    // request and returns immediately -- it does not wait for runAgent to
    // finish, and does not reflect whether the agent loop itself succeeds.
    // The agent Lambda (aiQueryReports/index.js) reports the real outcome
    // later via the "complete"/"fail" callback actions below.
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: AGENT_FUNCTION_NAME,
        InvocationType: "Event",
        Payload: JSON.stringify({
          action: "runAgent",
          requestId,
          question: augmentedPrompt,
          sessionId,
        }),
      }),
    );

    console.log("Invoked agent Lambda:", { requestId, sessionId });
  } catch (error) {
    console.error("Could not invoke the agent Lambda:", error);

    await markFailed(requestId, "Could not start the agent");

    return json(502, {
      error: "Could not start the agent",
    });
  }

  return json(202, {
    requestId,
    status: "processing",
  });
}

/**
 * Called repeatedly by the S3 web page.
 */
async function getStatus(query) {
  const requestId = query.requestId?.trim();

  if (!requestId) {
    return json(400, {
      error: "requestId is required",
    });
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        requestId,
      },
      ConsistentRead: true,
    }),
  );

  if (!result.Item) {
    return json(404, {
      error: "Request not found",
    });
  }

  const response = {
    requestId,
    status: result.Item.status,
  };

  if (result.Item.status === "complete") {
    response.answer = result.Item.answer;
  }

  if (result.Item.status === "failed") {
    response.error = result.Item.error ?? "The request failed";
  }

  return json(200, response);
}

/**
 * Receives the completed answer from the agent Lambda once its tool-calling
 * loop finishes.
 */
async function completeRequest(body) {
  if (CALLBACK_SECRET && body.callbackSecret !== CALLBACK_SECRET) {
    return json(401, {
      error: "Invalid callback secret",
    });
  }

  const requestId = body.requestId?.trim();

  if (!requestId) {
    return json(400, {
      error: "requestId is required",
    });
  }

  if (body.answer === undefined || body.answer === null) {
    return json(400, {
      error: "answer is required",
    });
  }

  const answer =
    typeof body.answer === "string"
      ? body.answer
      : JSON.stringify(body.answer, null, 2);

  const now = Math.floor(Date.now() / 1000);

  // Need the original request item to recover sessionId + raw question --
  // the callback only knows requestId and the answer.
  const existing = await dynamo.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { requestId },
    }),
  );

  if (!existing.Item) {
    return json(404, {
      error: "Request not found",
    });
  }

  try {
    await dynamo.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {
          requestId,
        },
        UpdateExpression:
          "SET #status = :complete, answer = :answer, updatedAt = :updatedAt REMOVE #error",
        ConditionExpression: "attribute_exists(requestId)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#error": "error",
        },
        ExpressionAttributeValues: {
          ":complete": "complete",
          ":answer": answer,
          ":updatedAt": now,
        },
      }),
    );
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") {
      return json(404, {
        error: "Request not found",
      });
    }

    throw error;
  }

  const sessionId = existing.Item.sessionId;
  const rawQuestion = existing.Item.question;

  if (sessionId && CONVERSATIONS_TABLE) {
    try {
      await appendTurn(sessionId, rawQuestion, answer);
    } catch (error) {
      // Don't fail the whole callback over history bookkeeping -- the user
      // still gets their answer even if conversation memory didn't save.
      console.error("Failed to update conversation history:", error);
    }
  }

  console.log("Request completed:", requestId);

  return json(200, {
    requestId,
    status: "complete",
  });
}

/**
 * Receives a failure report from the agent Lambda (e.g. the model errored
 * out, or the tool loop never converged on an answer).
 */
async function failRequest(body) {
  if (CALLBACK_SECRET && body.callbackSecret !== CALLBACK_SECRET) {
    return json(401, {
      error: "Invalid callback secret",
    });
  }

  const requestId = body.requestId?.trim();

  if (!requestId) {
    return json(400, {
      error: "requestId is required",
    });
  }

  await markFailed(requestId, body.error || "The agent failed");

  console.log("Request failed:", requestId, body.error);

  return json(200, {
    requestId,
    status: "failed",
  });
}

async function markFailed(requestId, message) {
  const now = Math.floor(Date.now() / 1000);

  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        requestId,
      },
      UpdateExpression:
        "SET #status = :failed, #error = :error, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
        "#error": "error",
      },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":error": message,
        ":updatedAt": now,
      },
    }),
  );
}

/**
 * Conversation history helpers
 */

async function getConversation(sessionId) {
  if (!CONVERSATIONS_TABLE) {
    return null;
  }

  const result = await dynamo.send(
    new GetCommand({
      TableName: CONVERSATIONS_TABLE,
      Key: { sessionId },
    }),
  );

  return result.Item ?? null;
}

// Compacts a rendered answer before storing it for follow-up prompt
// replay. This is ONLY for what gets fed back into future
// buildAugmentedPrompt calls -- the frontend independently stores and
// displays the full, rich answer in localStorage, so nothing the user
// sees changes.
//
// Why this exists: a follow-up question's prompt embeds the full text of
// prior answers (see buildAugmentedPrompt below), including any markdown
// tables -- pipe characters, backticks, bold markers. A first question has
// none of this; keeping history compact and length-capped keeps the prompt
// smaller and easier for the model to parse on later turns.
const MAX_HISTORY_ANSWER_CHARS = 2000;

function compactAnswerForHistory(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  let result = text;

  // Strip bold/emphasis markers and inline code backticks -- same words,
  // less punctuation.
  result = result.replace(/\*\*(.*?)\*\*/g, "$1");
  result = result.replace(/`([^`]*)`/g, "$1");

  // Collapse markdown tables into compact "Header: value, Header: value"
  // lines instead of pipe-delimited rows, and drop header-separator rows
  // entirely. Preserves the same information for resolving follow-up
  // references ("that project," "same for X") without the dense pipe
  // punctuation of a rendered table.
  const lines = result.split("\n");
  const outputLines = [];
  let tableHeader = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    const isSeparatorRow = isTableRow && /^[|\-\s:]+$/.test(trimmed);

    if (isSeparatorRow) {
      continue; // drop "|---|---|" rows entirely
    }

    if (isTableRow) {
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());

      if (!tableHeader) {
        tableHeader = cells;
      } else {
        const rowText = tableHeader
          .map((h, i) => `${h}: ${cells[i] ?? ""}`)
          .join(", ");
        outputLines.push(rowText);
      }
      continue;
    }

    tableHeader = null; // left the table block
    outputLines.push(line);
  }

  result = outputLines.join("\n");

  // Cap length for history-replay purposes only -- if a table was huge,
  // the user already saw it in full in the UI; the compacted history copy
  // just needs enough for the model to resolve a follow-up reference, not
  // a complete replay of hundreds of rows.
  if (result.length > MAX_HISTORY_ANSWER_CHARS) {
    result =
      result.slice(0, MAX_HISTORY_ANSWER_CHARS) +
      "\n... [truncated for follow-up context -- the full answer was already shown to the user]";
  }

  return result;
}

async function appendTurn(sessionId, question, answer) {
  const now = Math.floor(Date.now() / 1000);
  const conversationExpiresAt = now + CONVERSATION_IDLE_SECONDS;

  const existing = await getConversation(sessionId);
  const turns = existing?.turns ?? [];

  const compactAnswer = compactAnswerForHistory(answer);

  const updatedTurns = [
    ...turns,
    { q: question, a: compactAnswer, ts: now },
  ].slice(-MAX_TURNS);

  await dynamo.send(
    new PutCommand({
      TableName: CONVERSATIONS_TABLE,
      Item: {
        sessionId,
        turns: updatedTurns,
        // Placeholder for the structured entity/filter object (project,
        // client, date range, etc.) discussed separately -- not populated
        // yet. Carried through untouched so it's safe to add later.
        context: existing?.context ?? {},
        updatedAt: now,
        conversationExpiresAt,
      },
    }),
  );
}

/**
 * Terminology / definitions helpers.
 *
 * Single-tenant-per-deployment, so no instance-scoping key is needed here --
 * this whole table belongs to whichever SPP instance this deployment serves.
 * Revisit if this ever becomes multi-tenant (would need instanceName as
 * part of the key, and the definitions cache below would need to be keyed
 * per-instance too).
 */

let definitionsCache = { data: null, expiresAt: 0 };

async function getDefinitions() {
  if (!TERMS_TABLE) {
    return [];
  }

  const now = Date.now();
  if (definitionsCache.data && now < definitionsCache.expiresAt) {
    return definitionsCache.data;
  }

  const result = await dynamo.send(
    new ScanCommand({
      TableName: TERMS_TABLE,
    }),
  );

  const definitions = (result.Items ?? []).sort((a, b) =>
    a.term.localeCompare(b.term),
  );

  definitionsCache = {
    data: definitions,
    expiresAt: now + DEFINITIONS_CACHE_SECONDS * 1000,
  };

  return definitions;
}

function invalidateDefinitionsCache() {
  definitionsCache = { data: null, expiresAt: 0 };
}

async function listDefinitions() {
  if (!TERMS_TABLE) {
    return json(500, {
      error: "Lambda configuration is incomplete (TERMS_TABLE not set)",
    });
  }

  // Bypass the cache here -- this endpoint backs the settings UI, where a
  // stale read right after an edit would be confusing.
  const result = await dynamo.send(
    new ScanCommand({
      TableName: TERMS_TABLE,
    }),
  );

  const definitions = (result.Items ?? []).sort((a, b) =>
    a.term.localeCompare(b.term),
  );

  return json(200, { definitions });
}

async function saveDefinition(body) {
  const term = body.term?.trim();
  const definition = body.definition?.trim();

  if (!term || !definition) {
    return json(400, {
      error: "term and definition are both required",
    });
  }

  if (!TERMS_TABLE) {
    return json(500, {
      error: "Lambda configuration is incomplete (TERMS_TABLE not set)",
    });
  }

  const now = Math.floor(Date.now() / 1000);

  await dynamo.send(
    new PutCommand({
      TableName: TERMS_TABLE,
      Item: {
        term,
        definition,
        updatedAt: now,
      },
    }),
  );

  invalidateDefinitionsCache();

  return json(200, { term, definition });
}

async function deleteDefinition(body) {
  const term = body.term?.trim();

  if (!term) {
    return json(400, {
      error: "term is required",
    });
  }

  if (!TERMS_TABLE) {
    return json(500, {
      error: "Lambda configuration is incomplete (TERMS_TABLE not set)",
    });
  }

  await dynamo.send(
    new DeleteCommand({
      TableName: TERMS_TABLE,
      Key: { term },
    }),
  );

  invalidateDefinitionsCache();

  return json(200, { term, deleted: true });
}

function buildAugmentedPrompt(question, definitions, conversation, todayText) {
  const terms = definitions ?? [];
  const turns = conversation?.turns ?? [];
  const sections = [];

  if (todayText) {
    sections.push(
      [
        `Today's date is ${todayText}.`,
        "Use this as the reference point for interpreting any relative date",
        'phrase in the question (e.g. "this year," "last month," "year to',
        'date," "last quarter," "recently"). Prefer writing SQL using',
        "CURRENT_DATE/CURRENT_TIMESTAMP-relative expressions where",
        "reasonable (e.g. date >= date_trunc('year', CURRENT_DATE)) rather",
        "than a literal date you computed yourself, so the query stays",
        "correct if it's ever re-run on a different day.",
      ].join("\n"),
    );
  }

  if (terms.length > 0) {
    const definitionsBlock = terms
      .map((entry) => `- ${entry.term}: ${entry.definition}`)
      .join("\n");

    sections.push(
      [
        "This SPP instance defines the following terms in a specific way.",
        "Use these definitions whenever a question uses one of these terms,",
        "even if a different definition would otherwise seem reasonable.",
        "",
        "Defined terms:",
        definitionsBlock,
      ].join("\n"),
    );
  }

  if (turns.length > 0) {
    sections.push(
      [
        "You have already retrieved this instance's table schema earlier in",
        "this conversation via getSchemas. Do NOT call getSchemas again --",
        "reuse what you already know. The only exception is if a query fails",
        "specifically because it references a table or column that does not",
        "exist; only then may you call getSchemas once to check for a change.",
      ].join("\n"),
    );

    const historyBlock = turns
      .map((turn) => `Q: ${turn.q}\nA: ${turn.a}`)
      .join("\n\n");

    sections.push(
      [
        "The user's new question may be a follow-up that reuses the structure",
        "of a previous query with one changed value, or refers back to",
        'something mentioned earlier (e.g. "that project," "same for X").',
        "Check the recent exchanges below and resolve any such references",
        "before answering.",
        "",
        "Recent exchanges:",
        historyBlock,
      ].join("\n"),
    );
  }

  if (sections.length === 0) {
    return question;
  }

  sections.push(`New question: ${question}`);

  return sections.join("\n\n");
}

function parseBody(body) {
  if (!body) {
    return {};
  }

  if (typeof body === "object") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}
