const { DuckDBInstance } = require("@duckdb/node-api");

const REPORT_VIEWS = {
  customers: "s3://js-temp-storage/customer.csv",
  projectBillingRules: "s3://js-temp-storage/project_billing_rule.csv",
  projectMetrics:
    "s3://js-temp-storage/ANALYSIS__transactions_by_Project_User_report_pivot.csv",
  projects: "s3://js-temp-storage/project.csv",
  projectStages: "s3://js-temp-storage/project_stage.csv",
  tasks: "s3://js-temp-storage/project_task.csv",
  users: "s3://js-temp-storage/user.csv",
};

const RELATIONSHIPS = {
  "projectBillingRules.customer_id": { table: "customers", column: "id" },
  "projectBillingRules.project_id": { table: "projects", column: "id" },
  "projectMetrics.Project Internal id": { table: "projects", column: "id" },
  "projectMetrics.User Internal id": { table: "users", column: "id" },
  "projects.customer_id": { table: "customers", column: "id" },
  "projects.project_stage_id": { table: "projectStages", column: "id" },
  "projects.user_id": { table: "users", column: "id" },
  "tasks.project_id": { table: "projects", column: "id" },
};

let cachedConnection = null;
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

exports.handler = async (event) => {
  console.log("Received event (v15):", JSON.stringify(event, null, 2));
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
        error: `Unknown action "${action}". Must be "getSchemas" or "executeQuery".`,
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
