// Docker deployment:
// Open Docker Desktop
// In PowerShell, Login:  aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 776528084998.dkr.ecr.us-east-2.amazonaws.com
// In PowerShell, Deploy: .\deploy.ps1

// deploy.ps1, buildspec.yml, and Dockerfile are included at the bottom of this file for reference.

const { DuckDBInstance } = require("@duckdb/node-api");

const instanceName = process.env.SPP_INSTANCE_NAME || "top-step-sandbox";
const BUCKET = "topstep-ai-offering";
const DATA_PREFIX = "spp-data";
const basePath = `s3://${BUCKET}/${DATA_PREFIX}/${instanceName}`;

const REPORT_VIEWS = {
  customers: `${basePath}/customer.csv`,
  invoices: `${basePath}/invoice.csv`,
  projectBillingRules: `${basePath}/project_billing_rule.csv`,
  projectMetrics: `${basePath}/ANALYSIS__transactions_by_Project_User_report_pivot.csv`,
  projects: `${basePath}/project.csv`,
  projectStages: `${basePath}/project_stage.csv`,
  tasks: `${basePath}/project_task.csv`,
  timeEntries: `${basePath}/task.csv`,
  users: `${basePath}/user.csv`,
};

// One JSON file per table, e.g.:
// s3://topstep-ai-offering/spp-data/top-step-sandbox/_field-values/project_billing_rule.json
const FIELD_VALUES_PREFIX = `${basePath}/_field-values`;

const RELATIONSHIPS = {
  "invoices.customer_id": { table: "customers", column: "id" },
  "projectBillingRules.customer_id": { table: "customers", column: "id" },
  "projectBillingRules.project_id": { table: "projects", column: "id" },
  "projectMetrics.Project Internal id": { table: "projects", column: "id" },
  "projectMetrics.User Internal id": { table: "users", column: "id" },
  "projects.customer_id": { table: "customers", column: "id" },
  "projects.project_stage_id": { table: "projectStages", column: "id" },
  "projects.user_id": { table: "users", column: "id" },
  "tasks.project_id": { table: "projects", column: "id" },
  "timeEntries.customer_id": { table: "customers", column: "id" },
  "timeEntries.project_id": { table: "projects", column: "id" },
  "timeEntries.project_task_id": { table: "tasks", column: "id" },
  "timeEntries.user_id": { table: "users", column: "id" },
};

let cachedConnection = null;
const fieldValuesCache = {}; // viewName -> parsed JSON (or null if confirmed absent)

const TYPE_MAP = [
  "Invalid",
  "Boolean",
  "TinyInt",
  "SmallInt",
  "Integer",
  "BigInt",
  "UnsignedTinyInt",
  "UnsignedSmallInt",
  "UnsignedInteger",
  "UnsignedBigInt",
  "Float",
  "Double",
  "Timestamp",
  "Date",
  "Time",
  "Interval",
  "HugeInt",
  "String",
  "Blob",
  "Decimal",
  "TimestampSeconds",
  "TimestampMilliseconds",
  "TimestampNanoseconds",
  "Enumeration",
  "List",
  "Struct",
  "Map",
  "UUID",
  "Union",
  "Bit",
  "TimeZone",
  "TimestampTimeZone",
  "UnsignedHugeInt",
  "Array",
];

async function setupConnection(region) {
  if (cachedConnection) {
    console.log("Using cached DuckDB connection");
    return cachedConnection;
  }

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  await connection.run("SET home_directory='/tmp';");
  await connection.run("INSTALL httpfs;");
  await connection.run("LOAD httpfs;");
  await connection.run("INSTALL aws;");
  await connection.run("LOAD aws;");
  await connection.run(`
    CREATE SECRET s3_credentials (
      TYPE S3,
      PROVIDER CREDENTIAL_CHAIN,
      REGION '${region}'
    );
  `);

  for (const [viewName, s3Path] of Object.entries(REPORT_VIEWS)) {
    await connection.run(
      `CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_csv_auto('${s3Path}');`,
    );
  }

  cachedConnection = connection;
  return connection;
}

// Reads s3://.../_field-values/{viewName}.json via the existing DuckDB/httpfs
// connection (same credential chain as the CSV views) and parses it.
// Returns null if the file doesn't exist for that table (not every table
// needs one), and caches the result (including the null) for warm invocations.
async function getFieldValuesForTable(connection, viewName) {
  if (Object.prototype.hasOwnProperty.call(fieldValuesCache, viewName)) {
    return fieldValuesCache[viewName];
  }

  const s3Path = `${FIELD_VALUES_PREFIX}/${viewName}.json`;

  try {
    const reader = await connection.runAndReadAll(
      `SELECT content FROM read_text('${s3Path}');`,
    );
    const rows = await reader.getRowObjects();

    if (!rows.length || !rows[0].content) {
      fieldValuesCache[viewName] = null;
      return null;
    }

    const parsed = JSON.parse(rows[0].content);
    fieldValuesCache[viewName] = parsed;
    return parsed;
  } catch (error) {
    // Most common case: no field-values file exists for this table yet.
    console.log(
      `No field values found for "${viewName}" (${s3Path}): ${error.message}`,
    );
    fieldValuesCache[viewName] = null;
    return null;
  }
}

exports.handler = async (event) => {
  console.log("Received event (v16):", JSON.stringify(event, null, 2));
  const eventBody = JSON.parse(event.body);
  const region = eventBody.region || process.env.AWS_REGION || "us-east-2";
  const action = eventBody.action;

  try {
    const connection = await setupConnection(region);

    if (action === "getQuestion") {
      try {
        const questionId = eventBody.questionId;
        const question = testQuestions.find((q) => q.id === questionId);
        console.log(
          `getQuestion for id ${questionId}: ${JSON.stringify(question)}`,
        );
        return {
          statusCode: 200,
          body: JSON.stringify(question),
        };
      } catch (error) {
        console.error("getQuestion error:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: error.message }),
        };
      }
    }

    if (action === "getSchemas") {
      const schema = {};
      for (const viewName of Object.keys(REPORT_VIEWS)) {
        schema[viewName] = await getTableSchema(connection, viewName);
      }
      return {
        statusCode: 200,
        body: JSON.stringify({ schema }),
      };
    }

    if (action === "getFieldValues") {
      const table = eventBody.table;
      if (!table) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "table parameter is required for getFieldValues",
          }),
        };
      }
      if (!REPORT_VIEWS[table]) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: `Unknown table "${table}". Must be one of: ${Object.keys(REPORT_VIEWS).join(", ")}`,
          }),
        };
      }

      const fieldValues = await getFieldValuesForTable(connection, table);
      return {
        statusCode: 200,
        body: JSON.stringify({ table, fieldValues: fieldValues || {} }),
      };
    }

    if (action === "executeQuery") {
      const sqlQuery = eventBody.sql;
      if (!sqlQuery) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "sql parameter is required for executeQuery",
          }),
        };
      }
      // TODO: read-only guard belongs here — reject anything that isn't SELECT
      const reader = await connection.runAndReadAll(sqlQuery);

      const rows = await reader.getRowObjects();
      const cleanedRows = cleanRows(rows);
      const returnValue = JSON.stringify({ rows: cleanedRows }, (k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      console.log(`Query executed: ${sqlQuery} -- results: ${returnValue}`);
      return {
        statusCode: 200,
        body: returnValue,
      };
    }

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `Unknown action "${action}". Must be "getSchemas", "getFieldValues", or "executeQuery".`,
      }),
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};

function cleanRows(rows) {
  return rows.map((row) => {
    const cleaned = {};
    for (const [key, value] of Object.entries(row)) {
      if (value && typeof value === "object" && "micros" in value) {
        // convert DuckDB TIMESTAMP micros to an ISO string
        const micros =
          typeof value.micros === "bigint"
            ? value.micros
            : BigInt(value.micros);
        cleaned[key] = new Date(Number(micros / 1000n)).toISOString();
      } else if (value === "0000-00-00") {
        cleaned[key] = null;
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}

async function getTableSchema(connection, viewName) {
  const reader = await connection.runAndReadAll(
    `SELECT * FROM ${viewName} LIMIT 0;`,
  );
  const rawColumns = reader.columnNameAndTypeObjectsJson();

  return rawColumns.map((col) => {
    const entry = {
      name: col.columnName,
      type: TYPE_MAP[col.columnType.typeId],
    };

    const relKey = `${viewName}.${col.columnName}`;
    if (RELATIONSHIPS[relKey]) {
      entry.references = RELATIONSHIPS[relKey];
    }

    return entry;
  });
}

const testQuestions = [
  { id: 1, text: "What is the name of project 11?" },
  {
    id: 2,
    text: "Please list all of the projects with project_stage_id of 6 that are owned by Tres Churchill that do not have any bookings in 2025, meaning projects where the record count for bookings is zero.  Include the customer name, the project name, and the project id so I can tell them apart.",
  },
  {
    id: 3,
    text: "I need to know all of the users that were overutilized or underutilized in March of 2025.  Over-utilized means they had over 100 hours of time on projects that did not have a stage of 'Internal'.  Under-utilized means they had less than 40 hours of time on projects that did not have a stage of 'Internal'.  Please show each over- or under-utilized user and the hours they had in March of 2025.",
  },
  {
    id: 4,
    text: "I'd like to know how many hours have been put against each BGB Group project (BGB Group is the customer), and how much we've charged for each one",
  },
];

/* deploy.ps1 batch file:
$ErrorActionPreference = "Stop"

$AccountId = "776528084998"
$Region = "us-east-2"
$RepoName = "node-duckdb-lambda"
$FunctionName = "aiQueryReports"
$ImageUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$RepoName`:latest"

Write-Host "Building image..." -ForegroundColor Cyan
docker buildx build --platform linux/amd64 --provenance=false --output=type=docker -t $RepoName .

Write-Host "Tagging image..." -ForegroundColor Cyan
docker tag "$RepoName`:latest" $ImageUri

Write-Host "Pushing to ECR..." -ForegroundColor Cyan
docker push $ImageUri

Write-Host "Updating Lambda function..." -ForegroundColor Cyan
$env:AWS_PAGER = ""
aws lambda update-function-code --function-name $FunctionName --image-uri $ImageUri --query "LastUpdateStatus" --output text

Write-Host "Done." -ForegroundColor Green
*/

/* buildspec.yml file:

version: 0.2

phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $REPOSITORY_URI
  build:
    commands:
      - echo Build started on `date`
      - echo Building the Docker image...
      - docker build -t $REPOSITORY_URI:latest .
  post_build:
    commands:
      - echo Build completed on `date`
      - echo Pushing the Docker image...
      - docker push $REPOSITORY_URI:latest

*/

/* Dockerfile:

# Use the official AWS Lambda Node 24 image
FROM public.ecr.aws/lambda/nodejs:24

# Copy package.json over to the image
COPY package.json ${LAMBDA_TASK_ROOT}

# Install dependencies inside the Linux container so the binaries match AWS
RUN npm install

# Copy your actual code
COPY index.js ${LAMBDA_TASK_ROOT}

# Tell Lambda which function file and method to execute
CMD [ "index.handler" ]

*/
