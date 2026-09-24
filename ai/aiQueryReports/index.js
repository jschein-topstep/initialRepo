// Docker deployment:
// Open Docker Desktop
// In PowerShell, Login:  aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 776528084998.dkr.ecr.us-east-2.amazonaws.com
// In PowerShell, Deploy: .\deploy.ps1

// deploy.ps1, buildspec.yml, and Dockerfile are included at the bottom of this file for reference.

// To redeploy sppMcpServer:
//docker buildx build --platform linux/amd64 --provenance=false --output=type=docker -f ai/mcpServer/Dockerfile -t spp-mcp-server . 2>&1 | tail -10 && \
// docker tag spp-mcp-server:latest 776528084998.dkr.ecr.us-east-2.amazonaws.com/spp-mcp-server:latest && \
// docker push 776528084998.dkr.ecr.us-east-2.amazonaws.com/spp-mcp-server:latest 2>&1 | tail -5 && \
// aws lambda update-function-code --function-name sppMcpServer --image-uri 776528084998.dkr.ecr.us-east-2.amazonaws.com/spp-mcp-server:latest --region us-east-2 --query "LastUpdateStatus" --output text && \
// aws lambda wait function-updated --function-name sppMcpServer --region us-east-2 && echo "sppMcpServer updated"

const { DuckDBInstance } = require("@duckdb/node-api");
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

const instanceName = process.env.SPP_INSTANCE_NAME || "top-step-sandbox";
const BUCKET = "topstep-ai-offering";
const DATA_PREFIX = "spp-data";
const basePath = `s3://${BUCKET}/${DATA_PREFIX}/${instanceName}`;
console.log("basePath: " + basePath);

// Cut over from Celigo's recent/historical split files to sppDataSync's
// single incrementally-merged file per table (spp-data/{company}/sync/). A
// single-path entry gets a one-branch UNION ALL downstream -- functionally
// a no-op vs. the old two-path arrays, so nothing else needed to change to
// support this. Every one of these files carries a synthetic "deleted"
// column (see sppDataSync.js) that the old recent/historical files never
// had -- materializeTables strips it out (both the rows and the column
// itself), matching the old files' behavior of never containing deleted
// records at all.
const REPORT_VIEWS = {
  booking: `${basePath}/sync/booking.csv`,
  charges: `${basePath}/sync/slip.csv`,
  customers: `${basePath}/sync/customer.csv`,
  expenseReports: `${basePath}/sync/envelope.csv`,
  invoices: `${basePath}/sync/invoice.csv`,
  projectBillingRules: `${basePath}/sync/project_billing_rule.csv`,
  //projectMetrics: `${basePath}/ANALYSIS__transactions_by_Project_User_report_pivot.csv`,
  projects: `${basePath}/sync/project.csv`,
  projectStages: `${basePath}/sync/project_stage.csv`,
  receipts: `${basePath}/sync/ticket.csv`,
  tasks: `${basePath}/sync/project_task.csv`,
  timeEntries: `${basePath}/sync/task.csv`,
  timesheets: `${basePath}/sync/timesheet.csv`,
  users: `${basePath}/sync/user.csv`,
  bookingTypes: `${basePath}/sync/booking_type.csv`,
  budgets: `${basePath}/sync/budget.csv`,
  categories: `${basePath}/sync/category.csv`,
  additionalTeams: `${basePath}/sync/category_1.csv`,
  costCenters: `${basePath}/sync/cost_center.csv`,
  customerPOs: `${basePath}/sync/customer_po.csv`,
  customerPoProjectLinks: `${basePath}/sync/customer_po_to_project.csv`,
  departments: `${basePath}/sync/department.csv`,
  items: `${basePath}/sync/item.csv`,
  jobCodes: `${basePath}/sync/job_code.csv`,
  projectTaskAssignments: `${basePath}/sync/project_task_assignment.csv`,
  revenueRecognitionRules: `${basePath}/sync/revenue_recognition_rule.csv`,
  revenueRecognitionTransactions: `${basePath}/sync/revenue_recognition_transaction.csv`,
  scriptRequests: `${basePath}/sync/issue.csv`,
  subrecordCategories: `${basePath}/sync/issue_category.csv`,
  scriptRequestPriority: `${basePath}/sync/issue_severity.csv`,
  scriptType: `${basePath}/sync/issue_source.csv`,
  scriptRequestStage: `${basePath}/sync/issue_stage.csv`,
};

// One JSON file per table, e.g.:
// s3://topstep-ai-offering/spp-data/top-step-sandbox/_field-values/project_billing_rule.json
const FIELD_VALUES_PREFIX = `${basePath}/_field-values`;

// SPP uses "0000-00-00" as a sentinel for "no date" on some records. Most
// date-ish columns (acct_date, various status dates) are already typed as
// String in the schema, so that sentinel just sits there harmlessly as
// text. But a handful of columns get auto-detected as a real DATE type by
// read_csv_auto, and a "0000-00-00" value in one of those breaks the WHOLE
// TABLE's materialization -- not just a query that touches it -- since it
// fails while DuckDB is casting the full column during CREATE TABLE AS
// SELECT. This has to be handled at materialization time, not query time,
// and needs to hold up over time: new records (a charge, invoice, or
// timesheet entry saved before its date is filled in) can reintroduce this
// at any point, so a one-time manual data cleanup isn't durable -- this
// list gets NULLIF'd on every (re)materialization instead.
// Columns present on every SPP instance regardless of tenant-specific
// configuration -- these are standard fields, safe to assume everywhere.
//
// NOTE: this key MUST exactly match the corresponding key in REPORT_VIEWS
// (including singular/plural) -- materializeTables looks up
// DATE_COLUMNS[viewName] using the exact REPORT_VIEWS key, so a mismatch
// here (e.g. "bookings" here vs "booking" in REPORT_VIEWS) means that
// table's date columns silently get NONE of the sentinel/format handling
// below, with no error to indicate anything's wrong -- it just fails later
// when a "0000-00-00" or non-ISO date shows up in that specific table.
const DATE_COLUMNS_COMMON = {
  booking: ["start_date", "end_date", "created", "updated"],
  charges: ["date", "created", "updated"],
  customers: ["created", "updated"],
  expenseReports: ["date", "created", "updated"],
  invoices: ["date", "created", "updated"],
  timeEntries: ["date", "created", "updated"],
  projects: ["start_date", "finish_date", "created", "updated"],
  projectStages: ["created", "updated"],
  tasks: ["starts", "fnlt_date", "created", "updated"],
  users: ["created", "updated"],
  projectBillingRules: ["created", "updated"],
  receipts: ["date", "created", "updated"],
  timesheets: ["starts", "ends", "created", "updated"],
  bookingTypes: ["created", "updated"],
  budgets: ["date", "created", "updated"],
  categories: ["created", "updated"],
  additionalTeams: ["created", "updated"],
  costCenters: ["created", "updated"],
  customerPOs: ["date", "created", "updated"],
  customerPoProjectLinks: ["created", "updated"],
  departments: ["created", "updated"],
  items: ["created", "updated"],
  jobCodes: ["created", "updated"],
  projectTaskAssignments: ["created", "updated"],
  revenueRecognitionRules: ["start_date", "end_date", "created", "updated"],
  revenueRecognitionTransactions: ["date", "created", "updated"],
  scriptRequests: [
    "date",
    "date_resolution_expected",
    "date_resolution_required",
    "date_resolved",
    "created",
    "updated",
  ],
  subrecordCategories: ["created", "updated"],
  scriptRequestPriority: ["created", "updated"],
  scriptType: ["created", "updated"],
  scriptRequestStage: ["created", "updated"],
};

// Custom fields (custom_NNN) are configured per SPP instance -- a column
// that exists for one customer may not exist for another at all. Add an
// entry here per instanceName as each tenant's custom date fields are
// identified, rather than assuming they're universal (that assumption is
// what broke when a second tenant's users table had no custom_208 column).
//
// "top-step" has no custom_208 entry here (unlike "top-step-sandbox") as of
// the sppDataSync cutover -- its master.csv doesn't request that field, so
// it's not a column in the synced user.csv at all, and read_csv_auto's
// types={} override hard-errors on a column name that doesn't exist in the
// file (breaking the WHOLE users table, not just that column). Add it back
// here if it's ever added to the master.csv.
const DATE_COLUMNS_BY_INSTANCE = {
  "top-step-sandbox": {
    users: ["custom_208"],
  },
  // "triton": { /* add triton-specific custom date columns here if any */ },
};

function mergeDateColumns(common, instanceSpecific) {
  const merged = {};
  for (const [table, cols] of Object.entries(common)) {
    merged[table] = [...cols];
  }
  for (const [table, cols] of Object.entries(instanceSpecific ?? {})) {
    merged[table] = [...(merged[table] ?? []), ...cols];
  }
  return merged;
}

const DATE_COLUMNS = mergeDateColumns(
  DATE_COLUMNS_COMMON,
  DATE_COLUMNS_BY_INSTANCE[instanceName],
);

// NOTE: same exact-key-match requirement as DATE_COLUMNS_COMMON above --
// getTableSchema looks up RELATIONSHIPS["${viewName}.${columnName}"] using
// the exact REPORT_VIEWS key, so "bookings.project_id" would never match
// against the real table name "booking" and that column would silently
// come back with no "references" metadata in getSchemas at all.
const RELATIONSHIPS = {
  "booking.project_id": { table: "projects", column: "id" },
  "booking.user_id": { table: "users", column: "id" },
  "booking.owner_id": { table: "users", column: "id" },
  "booking.project_task_id": { table: "tasks", column: "id" },
  "charges.customer_id": { table: "customers", column: "id" },
  "charges.invoice_id": { table: "invoices", column: "id" },
  "charges.project_id": { table: "projects", column: "id" },
  "charges.project_task_id": { table: "tasks", column: "id" },
  "charges.user_id": { table: "users", column: "id" },
  "expenseReports.customer_id": { table: "customers", column: "id" },
  "expenseReports.project_id": { table: "projects", column: "id" },
  "expenseReports.user_id": { table: "users", column: "id" },
  "invoices.customer_id": { table: "customers", column: "id" },
  "projectBillingRules.customer_id": { table: "customers", column: "id" },
  "projectBillingRules.project_id": { table: "projects", column: "id" },
  // "projectMetrics.Project Internal id": { table: "projects", column: "id" },
  // "projectMetrics.User Internal id": { table: "users", column: "id" },
  "projects.customer_id": { table: "customers", column: "id" },
  "projects.project_stage_id": { table: "projectStages", column: "id" },
  "projects.user_id": { table: "users", column: "id" },
  "receipts.customer_id": { table: "customers", column: "id" },
  "receipts.project_id": { table: "projects", column: "id" },
  "receipts.envelope_id": { table: "expenseReports", column: "id" },
  "receipts.user_id": { table: "users", column: "id" },
  "tasks.project_id": { table: "projects", column: "id" },
  "timeEntries.customer_id": { table: "customers", column: "id" },
  "timeEntries.project_id": { table: "projects", column: "id" },
  "timeEntries.project_task_id": { table: "tasks", column: "id" },
  "timeEntries.user_id": { table: "users", column: "id" },
  "timesheets.user_id": { table: "users", column: "id" },
  "budgets.category_id": { table: "categories", column: "id" },
  "budgets.customer_id": { table: "customers", column: "id" },
  "budgets.project_id": { table: "projects", column: "id" },
  "categories.cost_center_id": { table: "costCenters", column: "id" },
  "customerPOs.customer_id": { table: "customers", column: "id" },
  "customerPoProjectLinks.customer_po_id": {
    table: "customerPOs",
    column: "id",
  },
  "customerPoProjectLinks.project_id": { table: "projects", column: "id" },
  "departments.user_id": { table: "users", column: "id" },
  "items.cost_center_id": { table: "costCenters", column: "id" },
  "projectTaskAssignments.job_code_id": { table: "jobCodes", column: "id" },
  "projectTaskAssignments.project_task_id": { table: "tasks", column: "id" },
  "projectTaskAssignments.user_id": { table: "users", column: "id" },
  "revenueRecognitionRules.customer_id": { table: "customers", column: "id" },
  "revenueRecognitionRules.project_id": { table: "projects", column: "id" },
  "revenueRecognitionRules.category_id": { table: "categories", column: "id" },
  "revenueRecognitionRules.cost_center_id": {
    table: "costCenters",
    column: "id",
  },
  "revenueRecognitionRules.customer_po_id": {
    table: "customerPOs",
    column: "id",
  },
  "revenueRecognitionTransactions.customer_id": {
    table: "customers",
    column: "id",
  },
  "revenueRecognitionTransactions.project_id": {
    table: "projects",
    column: "id",
  },
  "revenueRecognitionTransactions.project_task_id": {
    table: "tasks",
    column: "id",
  },
  "revenueRecognitionTransactions.slip_id": { table: "charges", column: "id" },
  "revenueRecognitionTransactions.revenue_recognition_rule_id": {
    table: "revenueRecognitionRules",
    column: "id",
  },
  "revenueRecognitionTransactions.category_id": {
    table: "categories",
    column: "id",
  },
  "revenueRecognitionTransactions.cost_center_id": {
    table: "costCenters",
    column: "id",
  },
  "revenueRecognitionTransactions.customer_po_id": {
    table: "customerPOs",
    column: "id",
  },
  "revenueRecognitionTransactions.job_code_id": {
    table: "jobCodes",
    column: "id",
  },
  "revenueRecognitionTransactions.task_id": {
    table: "timeEntries",
    column: "id",
  },
  "revenueRecognitionTransactions.ticket_id": {
    table: "receipts",
    column: "id",
  },
  "revenueRecognitionTransactions.user_id": { table: "users", column: "id" },
  "scriptRequests.issue_category_id": {
    table: "issueCategories",
    column: "id",
  },
  "scriptRequests.issue_severity_id": {
    table: "issueSeverities",
    column: "id",
  },
  "scriptRequests.issue_source_id": { table: "issueSources", column: "id" },
  "scriptRequests.issue_stage_id": { table: "issueStages", column: "id" },
  "scriptRequests.owner_id": { table: "users", column: "id" },
  "scriptRequests.project_id": { table: "projects", column: "id" },
  "scriptRequests.project_task_id": { table: "tasks", column: "id" },
  "scriptRequests.user_id": { table: "users", column: "id" },
  "scriptRequests.customer_id": { table: "customers", column: "id" },
};

// --- Connection + materialization caching ---------------------------------
//
// Views were replaced with materialized tables: a view re-reads and
// re-parses every underlying CSV from S3 on every single query, which was
// almost certainly the single biggest contributor to per-query latency.
// A table is loaded into memory once (on a cold start / new connection)
// and every query after that runs against in-memory data.
//
// Trade-off: a warm container's data can go stale if the CSVs are
// refreshed in S3. STALENESS_CHECK_INTERVAL_MS below bounds how long a
// warm container can serve stale data before re-checking -- it does a
// cheap HeadObject (not a re-download) against each CSV and only
// re-materializes tables whose LastModified actually changed.

let cachedConnection = null;
let lastManifest = {}; // viewName -> ISO LastModified string, as of last (re)materialization
let lastStalenessCheckAt = 0;

const STALENESS_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const fieldValuesCache = {}; // viewName -> parsed JSON (or null if confirmed absent)
let cachedSchema = null; // computed once per materialization, reused by getSchemas

const s3Client = new S3Client({});

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

// --- Mojibake repair for historical SPP data -------------------------------
//
// Confirmed via direct testing against real SPP notes data: years of free
// text in fields like charges.notes, tasks.name, and invoices.notes contain
// genuine mojibake -- UTF-8 bytes that got misread as Latin-1/cp1252 at some
// point in SPP's history (or an export/import step) and were permanently
// written back as the wrong characters (e.g. an accented "a" stored as two
// garbled characters instead of one accented character). That's data
// corruption baked into the source, not something we can fix by reading it
// differently now -- but it can often be reversed: re-encoding the (wrongly
// decoded) text as Latin-1 bytes and decoding those bytes as UTF-8
// frequently recovers the original text. This only works for genuine
// single-round Latin-1-as-UTF-8 corruption; text that doesn't match that
// pattern (or shows signs of multiple corruption passes) is returned
// unchanged rather than mangled further.

function repairMojibake(text) {
  if (typeof text !== "string" || text.length === 0) {
    return text;
  }

  // Only attempt this if every character is in the Latin-1 range (0-255).
  // That's the actual signature of this corruption pattern; genuine other-
  // script text (CJK, emoji, etc.) would get mangled by this same trick, so
  // leave those alone.
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) {
      return text;
    }
  }

  try {
    const repaired = Buffer.from(text, "latin1").toString("utf8");
    // Node's utf8 decoder substitutes U+FFFD for invalid byte sequences
    // instead of throwing -- if that happened, the repair attempt produced
    // garbage, not real text, so don't trust it.
    return repaired.includes("\uFFFD") ? text : repaired;
  } catch {
    return text;
  }
}

function sanitizeFieldValues(value) {
  if (typeof value === "string") {
    return repairMojibake(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeFieldValues);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeFieldValues(v);
    }
    return result;
  }
  return value;
}

function parseS3Path(s3Path) {
  // s3://bucket/key/with/slashes.csv -> { bucket, key }
  const withoutScheme = s3Path.replace(/^s3:\/\//, "");
  const firstSlash = withoutScheme.indexOf("/");
  return {
    bucket: withoutScheme.slice(0, firstSlash),
    key: withoutScheme.slice(firstSlash + 1),
  };
}

async function getCurrentManifest() {
  const manifest = {};

  await Promise.all(
    Object.entries(REPORT_VIEWS).map(async ([viewName, s3PathOrPaths]) => {
      // Same "one path or many" handling as materializeTables -- a table
      // backed by multiple S3 files (e.g. charges: recent + historical)
      // needs every file checked; the table is treated as changed if ANY
      // of them have a newer LastModified than what's on record.
      const paths = Array.isArray(s3PathOrPaths)
        ? s3PathOrPaths
        : [s3PathOrPaths];

      try {
        const timestamps = await Promise.all(
          paths.map(async (s3Path) => {
            const { bucket, key } = parseS3Path(s3Path);
            const head = await s3Client.send(
              new HeadObjectCommand({ Bucket: bucket, Key: key }),
            );
            return head.LastModified
              ? head.LastModified.toISOString()
              : "unknown";
          }),
        );
        // Joined into one string so manifestsMatch's simple equality check
        // still works unchanged -- a single-path table just gets a
        // one-element join, identical to its old behavior.
        manifest[viewName] = timestamps.join("|");
      } catch (error) {
        // If we can't HEAD any one of them, don't block startup on this --
        // surface as unknown so a subsequent check will retry.
        console.log(
          `HeadObject failed for ${viewName} (${paths.join(", ")}): ${error.message}`,
        );
        manifest[viewName] = null;
      }
    }),
  );

  return manifest;
}

function manifestsMatch(a, b) {
  const keys = Object.keys(REPORT_VIEWS);
  return keys.every((key) => a[key] && a[key] === b[key]);
}

async function getNonEmptyPaths(paths) {
  // A source CSV that's genuinely 0 bytes (no header, no rows) makes
  // read_csv_auto fail outright -- it has nothing to sniff a schema from,
  // so the whole UNION ALL for that table blows up even though the sibling
  // file (historical or recent) has perfectly good data. Filter those out
  // before building the query. A HeadObject failure here (permissions,
  // transient network) is different from "confirmed empty" -- keep the
  // path in that case and let read_csv_auto surface the real problem,
  // rather than silently dropping a file we just couldn't check.
  const checked = await Promise.all(
    paths.map(async (path) => {
      try {
        const { bucket, key } = parseS3Path(path);
        const head = await s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return { path, isEmpty: head.ContentLength === 0 };
      } catch (error) {
        console.log(
          `HeadObject failed for ${path} while checking for empty file (keeping it): ${error.message}`,
        );
        return { path, isEmpty: false };
      }
    }),
  );

  const nonEmpty = checked.filter((c) => !c.isEmpty).map((c) => c.path);
  const emptyPaths = checked.filter((c) => c.isEmpty).map((c) => c.path);

  if (emptyPaths.length > 0) {
    console.log(`Skipping empty source file(s): ${emptyPaths.join(", ")}`);
  }

  // If every path came back empty, fall back to the original list so the
  // table still gets created (empty, but with a real schema) rather than
  // handing materializeTables a zero-length union.
  return nonEmpty.length > 0 ? nonEmpty : paths;
}

// Returns the list of viewNames that failed to materialize (empty if all
// succeeded). Each table is isolated in its own try/catch -- one missing or
// malformed S3 file must not take down every OTHER table along with it.
// Confirmed happening in production: referencing a not-yet-synced table's
// file in REPORT_VIEWS threw on the very first table processed, aborting
// the whole loop and breaking every table, including 20+ that were working
// fine moments earlier. A failed table is simply never CREATEd (or, on a
// warm re-materialize, keeps whatever it had before -- CREATE OR REPLACE
// never runs, so the prior version isn't touched) -- getSchema separately
// skips any view that isn't actually queryable, so a broken table doesn't
// show up as available either.
async function materializeTables(connection, viewNames) {
  const failedViewNames = [];

  for (const viewName of viewNames) {
    try {
      await materializeOneTable(connection, viewName);
    } catch (error) {
      failedViewNames.push(viewName);
      console.error(
        `Failed to materialize "${viewName}" -- skipping it, other tables are unaffected: ${error.message}`,
      );
    }
  }

  if (failedViewNames.length > 0) {
    console.error(
      `materializeTables: ${failedViewNames.length} of ${viewNames.length} table(s) failed: ${failedViewNames.join(", ")}`,
    );
  }

  return failedViewNames;
}

async function materializeOneTable(connection, viewName) {
  {
    const s3Paths = REPORT_VIEWS[viewName];
    const allPaths = Array.isArray(s3Paths) ? s3Paths : [s3Paths];
    const paths = await getNonEmptyPaths(allPaths);
    const dateCols = DATE_COLUMNS[viewName] ?? [];

    // sample_size=-1 makes DuckDB scan the ENTIRE file to decide each
    // column's type, instead of just a sample (20480 rows by default).
    // Without this, a column can get auto-detected based on what LOOKS
    // like a consistent type in the sample (e.g. all-numeric), then blow
    // up later when a rare value outside that sample doesn't fit -- e.g.
    // a "*_filter" column that holds mostly single numeric IDs but
    // occasionally a comma-separated list like "124,67", which only
    // appeared beyond the default sample window. This is a different
    // failure class from the DATE_COLUMNS sentinel-value problem below:
    // that's a value that's genuinely incompatible with its real type no
    // matter how much you sample; this is auto-detection guessing the
    // wrong type in the first place. sample_size=-1 fixes the latter
    // category generally, for every column on every table, rather than
    // needing an explicit override added one crash at a time.
    const csvOptions = ["sample_size=-1"];

    if (dateCols.length > 0) {
      // read_csv_auto does its own type detection and casting DURING the
      // scan itself, before any outer SELECT runs -- so if it auto-detects
      // a column as DATE, it tries to parse every value into a real DATE
      // while reading the file, and "0000-00-00" fails right there. Our
      // NULLIF in the outer query never gets a chance to run on a column
      // that already blew up upstream. Fix: force these specific columns
      // to be read as plain VARCHAR (skipping DATE auto-detection
      // entirely), then NULLIF the sentinel on the safe string value and
      // cast to DATE ourselves only afterward, once it's gone. (This is
      // NOT something sample_size=-1 fixes on its own -- "0000-00-00" is a
      // real value that exists in a full scan too, and will still break a
      // DATE auto-detection/cast regardless of how much of the file is
      // sampled.)
      const typesOverride = dateCols
        .map((col) => `'${col}': 'VARCHAR'`)
        .join(", ");
      csvOptions.push(`types={${typesOverride}}`);
    }

    // Split tables (historical.csv + recent.csv) get UNION ALL'd here into
    // one logical source. Everything downstream of this -- date casting,
    // the materialized table name, and every query the AI agent writes --
    // stays completely unaware the underlying data ever lived in more than
    // one S3 file. Non-split tables (a single path) just get a one-branch
    // union, which is a no-op performance-wise.
    const unionedSource = paths
      .map(
        (path) =>
          `SELECT * FROM read_csv_auto('${path}', ${csvOptions.join(", ")})`,
      )
      .join(" UNION ALL ");

    // Different SPP tenants export dates in different formats depending on
    // regional/locale settings -- ISO (YYYY-MM-DD) in some datasets, US
    // style (M/D/YYYY) in others, sometimes even mixed within the same
    // column. A plain CAST(... AS DATE) only accepts ISO and fails hard on
    // anything else. try_strptime tries each format in the list in turn
    // and returns NULL (rather than erroring) if none match -- confirmed
    // via direct testing against ISO dates, US-style dates, the
    // "0000-00-00" sentinel, real NULLs, and genuinely invalid values, all
    // in the same column. Add more formats here if a future dataset uses
    // something else (e.g. "%d/%m/%Y" for day-first locales).
    //
    // '%Y-%m-%d %H:%M:%S' is required for sppDataSync's audit columns --
    // flattenFieldValue deliberately keeps full time-of-day precision for
    // created/updated (e.g. "2026-09-15 12:31:07"), unlike plain "date"
    // business fields, which stay date-only. Without this format,
    // try_strptime matches neither of the other two and CAST(NULL AS DATE)
    // silently succeeds -- confirmed live: 0 of 2310 projects had a
    // non-null "created" before this was added, despite every row having a
    // real value in the raw S3 file. The CAST to DATE below still drops
    // the time component on purpose, same as it always has -- this format
    // just lets a real value get through try_strptime in the first place.
    const DATE_FORMATS = ["'%Y-%m-%d %H:%M:%S'", "'%Y-%m-%d'", "'%m/%d/%Y'"];

    // Every sync file carries a synthetic "deleted" column (see
    // sppDataSync.js) that the old Celigo recent/historical files never
    // had -- EXCLUDE drops it from the materialized schema entirely (the
    // AI agent never sees or has to reason about it), and the WHERE below
    // drops the rows themselves, matching the old files' behavior of never
    // containing deleted records in the first place.
    const selectClause =
      dateCols.length > 0
        ? `SELECT * EXCLUDE (deleted) REPLACE (${dateCols
            .map(
              (col) =>
                `CAST(try_strptime(NULLIF("${col}", '0000-00-00'), [${DATE_FORMATS.join(", ")}]) AS DATE) AS "${col}"`,
            )
            .join(", ")})`
        : "SELECT * EXCLUDE (deleted)";

    const t0 = Date.now();
    await connection.run(
      `CREATE OR REPLACE TABLE ${viewName} AS ${selectClause} FROM (${unionedSource}) AS combined WHERE COALESCE(deleted, '0') != '1';`,
    );
    console.log(`Materialized "${viewName}" in ${Date.now() - t0}ms`);
  }
}

async function setupConnection(region, timings) {
  const now = Date.now();

  if (cachedConnection) {
    const dueForStalenessCheck =
      now - lastStalenessCheckAt >= STALENESS_CHECK_INTERVAL_MS;

    if (!dueForStalenessCheck) {
      timings.connectionSource = "cached (no staleness check due)";
      return cachedConnection;
    }

    const t0 = Date.now();
    const currentManifest = await getCurrentManifest();
    timings.stalenessCheckMs = Date.now() - t0;
    lastStalenessCheckAt = now;

    if (manifestsMatch(currentManifest, lastManifest)) {
      timings.connectionSource = "cached (staleness check passed)";
      return cachedConnection;
    }

    console.log(
      "Source data changed in S3 -- re-materializing affected tables",
    );
    const changedTables = Object.keys(REPORT_VIEWS).filter(
      (viewName) => currentManifest[viewName] !== lastManifest[viewName],
    );

    const t1 = Date.now();
    const failedViewNames = await materializeTables(cachedConnection, changedTables);
    timings.rematerializeMs = Date.now() - t1;
    if (failedViewNames.length > 0) {
      timings.materializeFailures = failedViewNames;
    }

    lastManifest = currentManifest;
    cachedSchema = null; // invalidate -- recomputed lazily on next getSchemas call
    timings.connectionSource = "cached (re-materialized stale tables)";
    return cachedConnection;
  }

  // Cold start: build everything from scratch.
  timings.connectionSource = "cold start";

  const t0 = Date.now();
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  timings.instanceCreateMs = Date.now() - t0;

  const t1 = Date.now();
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
  timings.extensionSetupMs = Date.now() - t1;
  // If this number is consistently large, the httpfs/aws extensions are
  // likely being fetched over the network on every cold start rather than
  // bundled in the image -- worth vendoring them into the Docker image.

  const t2 = Date.now();
  const failedViewNames = await materializeTables(connection, Object.keys(REPORT_VIEWS));
  timings.materializeAllMs = Date.now() - t2;
  if (failedViewNames.length > 0) {
    timings.materializeFailures = failedViewNames;
  }

  lastManifest = await getCurrentManifest();
  lastStalenessCheckAt = Date.now();

  cachedConnection = connection;
  return cachedConnection;
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
    const sanitized = sanitizeFieldValues(parsed);
    fieldValuesCache[viewName] = sanitized;
    return sanitized;
  } catch (error) {
    // Most common case: no field-values file exists for this table yet.
    console.log(
      `No field values found for "${viewName}" (${s3Path}): ${error.message}`,
    );
    fieldValuesCache[viewName] = null;
    return null;
  }
}

async function getSchema(connection, timings) {
  if (cachedSchema) {
    timings.schemaSource = "cached";
    return cachedSchema;
  }

  const t0 = Date.now();
  const schema = {};
  for (const viewName of Object.keys(REPORT_VIEWS)) {
    try {
      schema[viewName] = await getTableSchema(connection, viewName);
    } catch (error) {
      // A view that failed to materialize (see materializeTables) was
      // never actually CREATEd, so introspecting it throws -- omit it from
      // the schema entirely rather than letting one broken table crash
      // getSchemas for every OTHER table too. The agent simply won't know
      // this table exists, same as if it weren't in REPORT_VIEWS at all.
      console.error(`Omitting "${viewName}" from schema -- not queryable: ${error.message}`);
    }
  }
  timings.schemaComputeMs = Date.now() - t0;
  timings.schemaSource = "computed";

  cachedSchema = schema;
  return schema;
}

// Finds the first balanced {...} object in a string and returns it as a
// substring, ignoring anything before the opening brace or after its
// matching closing brace (e.g. a leaked "</invoke>" tag). Tracks whether
// we're inside a JSON string literal (and handles escaped quotes) so that
// braces appearing inside a SQL string value don't throw off the brace
// count. Returns null if no balanced object is found.
function extractJsonObject(str) {
  const start = str.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return str.slice(start, i + 1);
      }
    }
  }

  return null; // never found a matching close brace
}

// Thrown for a bad tool call (missing/unknown parameter, invalid SQL shape,
// etc.) as opposed to a real server error -- callers turn this into a 400
// over HTTP, or feed .message straight back to the agent as a tool_result
// over the direct runAgent path, since these messages are already written
// as "fix and retry" instructions aimed at the model.
class ToolInputError extends Error {}

async function performGetSchemas(connection, timings) {
  const schema = await getSchema(connection, timings);
  return { schema };
}

async function performGetFieldValues(connection, table) {
  if (!table) {
    throw new ToolInputError("table parameter is required for getFieldValues");
  }
  if (!REPORT_VIEWS[table]) {
    throw new ToolInputError(
      `Unknown table "${table}". Must be one of: ${Object.keys(REPORT_VIEWS).join(", ")}`,
    );
  }

  const fieldValues = await getFieldValuesForTable(connection, table);
  return { table, fieldValues: fieldValues || {} };
}

async function performExecuteQuery(connection, sqlQuery, timings) {
  if (!sqlQuery) {
    throw new ToolInputError("sql parameter is required for executeQuery");
  }
  // TODO: read-only guard belongs here - reject anything that isn't SELECT

  // Deterministic backstop against a recurring agent mistake: even with
  // explicit instructions (including a literal WRONG/RIGHT example), the
  // agent has repeatedly tried to "reconstruct" a column that's already
  // typed DATE by casting it to some other type and adding it to the Unix
  // epoch anchor (e.g. DATE '1970-01-01' + (col::INTEGER || ' days')::
  // INTERVAL). The agent varied the intermediate cast type across attempts
  // (INTEGER, then TEXT) while keeping the same fundamentally wrong shape --
  // a guard checking for one specific cast type only catches that one
  // variant and misses the next. Checking for the epoch anchor literal
  // itself is far more robust: no legitimate SPP business question has any
  // reason to reference 1970-01-01, so this one check catches every
  // cast-type variant of the same mistake without needing to enumerate them.
  if (/1970-01-01/.test(sqlQuery)) {
    console.log(
      `Rejected query: epoch-anchor date reconstruction attempted. SQL: ${sqlQuery}`,
    );
    throw new ToolInputError(
      `INVALID QUERY -- DO NOT SHOW THIS ERROR TO THE USER. Fix and ` +
        `re-run the query now -- this is a mistake you can correct ` +
        `immediately, not something to report. This query attempts to ` +
        `reconstruct a date value using the 1970-01-01 epoch anchor plus ` +
        `interval arithmetic. This is never correct in this data: every ` +
        `column reported as type Date or Timestamp by getSchemas is ` +
        `already a real date value and needs no such reconstruction, ` +
        `regardless of what type you cast it to first (INTEGER, TEXT, or ` +
        `anything else). Remove the epoch-arithmetic entirely and select ` +
        `the date column directly, e.g. "start_date" AS start_date, with ` +
        `no CAST at all. Retry the corrected query now before responding ` +
        `to the user.`,
    );
  }

  const queryStart = Date.now();
  let reader;
  try {
    reader = await connection.runAndReadAll(sqlQuery);
  } catch (queryError) {
    // The agent has occasionally fabricated a column/table name that was
    // never real in this schema (not a type-confusion or data-quirk issue --
    // just an invented name, e.g. "state_region" when the actual column is
    // "state"). DuckDB's own binder error is already quite good here -- it
    // typically suggests the real column name via "Candidate bindings" --
    // but left as a plain error, that hint has nowhere useful to go; it
    // just surfaces as a confusing failure instead of the agent silently
    // correcting itself. Same "fix and retry now" framing as the
    // epoch-anchor guard above, applied here to any "doesn't exist" binder
    // error instead of one specific bad column name.
    const isMissingColumnOrTable =
      /binder error/i.test(queryError.message) &&
      (/does not have a column named/i.test(queryError.message) ||
        /does not exist/i.test(queryError.message) ||
        /candidate bindings/i.test(queryError.message));

    if (isMissingColumnOrTable) {
      console.log(
        `Rejected query: referenced a column/table that does not exist. SQL: ${sqlQuery} -- Error: ${queryError.message}`,
      );
      throw new ToolInputError(
        `INVALID QUERY -- DO NOT SHOW THIS ERROR TO THE USER. This query ` +
          `referenced a column or table name that does not actually exist ` +
          `in this schema -- do not guess or assume a name based on what ` +
          `seems plausible. Call action="getSchemas" again to confirm the ` +
          `exact real column/table names (the error below may already ` +
          `suggest the correct one), then rewrite and retry the query now, ` +
          `before responding to the user. Original error: ${queryError.message}`,
      );
    }

    throw queryError;
  }
  timings.queryExecMs = Date.now() - queryStart;

  const rows = await reader.getRowObjects();
  const cleanedRows = cleanRows(rows);
  console.log(
    `Query executed: ${sqlQuery} -- timings: ${JSON.stringify(timings)}`,
  );
  return { rows: cleanedRows };
}

// --- Agent (Claude) configuration ------------------------------------------
//
// Runs the tool-calling loop directly against the Anthropic API -- this
// Lambda used to be a pure DuckDB tool called by a Celigo-hosted agent flow;
// it now also IS the agent, since Celigo has been removed from the
// pipeline. aiProcessQuestions.mjs still builds the augmented prompt (today's
// date, terminology definitions, conversation history) and hands it off here
// via an async Lambda invoke; this file owns the model calls, the tool loop,
// and reporting the outcome back over HTTP.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const CALLBACK_URL = process.env.CALLBACK_URL;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const MAX_AGENT_ITERATIONS = 25;
const AGENT_MAX_TOKENS = 8192;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const AGENT_SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "agent-instructions.txt"),
  "utf8",
);
const AGENT_TOOL_DESCRIPTION = fs.readFileSync(
  path.join(__dirname, "tool-description.txt"),
  "utf8",
);

const AGENT_TOOL_DEFINITION = {
  name: "query_spp_data",
  description: AGENT_TOOL_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["getSchemas", "getFieldValues", "executeQuery"],
        description: "Which step to perform.",
      },
      table: {
        type: "string",
        description: 'Table name -- required when action is "getFieldValues".',
      },
      sql: {
        type: "string",
        description:
          'A single read-only SELECT statement -- required when action is "executeQuery".',
      },
    },
    required: ["action"],
  },
};

async function executeAgentTool(connection, input, timings) {
  try {
    const action = input?.action;

    if (action === "getSchemas") {
      return JSON.stringify(await performGetSchemas(connection, timings));
    }
    if (action === "getFieldValues") {
      return JSON.stringify(
        await performGetFieldValues(connection, input.table),
      );
    }
    if (action === "executeQuery") {
      return JSON.stringify(
        await performExecuteQuery(connection, input.sql, timings),
        (k, v) => (typeof v === "bigint" ? v.toString() : v),
      );
    }

    return JSON.stringify({
      error: `Unknown action "${action}". Must be "getSchemas", "getFieldValues", or "executeQuery".`,
    });
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

async function runAgent(payload, timings) {
  const region = payload.region || process.env.AWS_REGION || "us-east-2";
  const connection = await setupConnection(region, timings);

  const messages = [{ role: "user", content: payload.question }];

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: AGENT_MAX_TOKENS,
      system: AGENT_SYSTEM_PROMPT,
      tools: [AGENT_TOOL_DEFINITION],
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const resultText = await executeAgentTool(
        connection,
        block.input,
        timings,
      );
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultText,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(
    `Agent exceeded ${MAX_AGENT_ITERATIONS} tool-call iterations without producing a final answer.`,
  );
}

async function reportOutcome(payload) {
  try {
    const response = await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, callbackSecret: CALLBACK_SECRET }),
    });
    if (!response.ok) {
      console.error(
        `Callback POST failed with HTTP ${response.status}:`,
        await response.text(),
      );
    }
  } catch (error) {
    console.error("Could not POST outcome back to the callback URL:", error);
  }
}

// Invoked asynchronously (InvocationType "Event") by aiProcessQuestions.mjs,
// so the payload arrives as the raw `event` object directly -- no
// requestContext/body wrapper like the HTTP actions below get. Never lets an
// error escape this function: an uncaught throw here would make Lambda retry
// the async invocation automatically (up to twice more), which would re-run
// the whole agent loop and could double-answer or double-bill. Failures are
// instead reported to aiProcessQuestions.mjs via the "fail" callback action.
async function handleRunAgent(payload, timings, handlerStart) {
  const { requestId } = payload;

  try {
    const answer = await runAgent(payload, timings);
    await reportOutcome({ action: "complete", requestId, answer });
  } catch (error) {
    console.error(`runAgent failed for requestId ${requestId}:`, error);
    await reportOutcome({ action: "fail", requestId, error: error.message });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      requestId,
      timingsMs: finalizeTimings(timings, handlerStart),
    }),
  };
}

exports.handler = async (event) => {
  const handlerStart = Date.now();
  const timings = {};

  console.log("Received event (v22):", JSON.stringify(event, null, 2));

  if (event.action === "runAgent") {
    return await handleRunAgent(event, timings, handlerStart);
  }

  const rawBody = JSON.parse(event.body);

  // This HTTP entry point (getQuestion/getSchemas/getFieldValues/
  // executeQuery) is no longer used by the normal question-answering flow --
  // the runAgent path above calls performGetSchemas/performGetFieldValues/
  // performExecuteQuery directly, in-process. It's kept as a plain HTTP
  // interface for manual testing/debugging. The shape-normalization below
  // was originally a workaround for Celigo's own tool-call relay mangling
  // its payloads (stringified "input", leaked "</invoke>" tags); it's
  // vestigial now that nothing calls this over HTTP with that shape, but
  // it's harmless to leave in place as a tolerant parser. Observed shapes:
  //   1. { input: { action, sql, ... } }        -- the normal, correct shape
  //   2. { action, sql, ... }                    -- "input" wrapper dropped entirely
  //   3. { input: "{\"action\":...,\"sql\":...}" } -- "input" present but stringified
  //      instead of a real nested object
  //   4. { input: "{\"action\":...,\"sql\":...}\n</invoke>" } -- stringified JSON
  //      PLUS leaked internal formatting (an XML-style tool-call closing tag)
  //      appended after it, making the whole string invalid JSON on its own
  // Normalize all of these to a plain object rather than failing the
  // request.
  let eventBody;
  let normalizedShape = null;

  if (rawBody.input && typeof rawBody.input === "object") {
    eventBody = rawBody.input;
  } else if (typeof rawBody.input === "string") {
    try {
      eventBody = JSON.parse(rawBody.input);
      normalizedShape = "input was a JSON string, parsed it";
    } catch (firstError) {
      // The plain string wasn't valid JSON on its own -- try extracting a
      // balanced {...} object from within it and ignoring anything (like a
      // leaked closing tag) trailing after that object.
      const extracted = extractJsonObject(rawBody.input);
      if (extracted !== null) {
        try {
          eventBody = JSON.parse(extracted);
          normalizedShape =
            "input was a JSON string with trailing garbage after it, extracted the object";
        } catch (secondError) {
          console.error(
            'Tool call had a string "input"; extracted a {...} substring but it still failed to parse:',
            rawBody.input,
            secondError.message,
          );
          return {
            statusCode: 400,
            body: JSON.stringify({
              error: `"input" was a string that could not be parsed as JSON, even after extracting what looked like a JSON object: ${secondError.message}`,
            }),
          };
        }
      } else {
        console.error(
          'Tool call had a string "input" that failed to parse as JSON:',
          rawBody.input,
          firstError.message,
        );
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: `"input" was a string that could not be parsed as JSON: ${firstError.message}`,
          }),
        };
      }
    }
  } else if (rawBody.action || rawBody.sql || rawBody.table) {
    eventBody = rawBody;
    normalizedShape = 'no "input" wrapper, used top-level fields';
  } else {
    eventBody = rawBody;
  }

  if (normalizedShape) {
    console.log(
      `Normalized malformed tool call (${normalizedShape}). Raw body:`,
      JSON.stringify(rawBody),
    );
  }

  const region = eventBody.region || process.env.AWS_REGION || "us-east-2";
  const action = eventBody.action;

  try {
    const connectionStart = Date.now();
    const connection = await setupConnection(region, timings);
    timings.setupConnectionMs = Date.now() - connectionStart;

    if (action === "getQuestion") {
      try {
        const questionId = eventBody.questionId;
        const question = testQuestions.find((q) => q.id === questionId);
        console.log(
          `getQuestion for id ${questionId}: ${JSON.stringify(question)}`,
        );
        return {
          statusCode: 200,
          body: JSON.stringify({
            ...question,
            timingsMs: finalizeTimings(timings, handlerStart),
          }),
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
      const result = await performGetSchemas(connection, timings);
      return {
        statusCode: 200,
        body: JSON.stringify({
          ...result,
          timingsMs: finalizeTimings(timings, handlerStart),
        }),
      };
    }

    if (action === "getFieldValues") {
      try {
        const result = await performGetFieldValues(connection, eventBody.table);
        return {
          statusCode: 200,
          body: JSON.stringify({
            ...result,
            timingsMs: finalizeTimings(timings, handlerStart),
          }),
        };
      } catch (error) {
        if (error instanceof ToolInputError) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: error.message }),
          };
        }
        throw error;
      }
    }

    if (action === "executeQuery") {
      try {
        const result = await performExecuteQuery(
          connection,
          eventBody.sql,
          timings,
        );
        return {
          statusCode: 200,
          body: JSON.stringify(
            {
              ...result,
              timingsMs: finalizeTimings(timings, handlerStart),
            },
            (k, v) => (typeof v === "bigint" ? v.toString() : v),
          ),
        };
      } catch (error) {
        if (error instanceof ToolInputError) {
          return {
            statusCode: 400,
            body: JSON.stringify({ error: error.message }),
          };
        }
        throw error;
      }
    }

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `Unknown action "${action}". Must be "getSchemas", "getFieldValues", or "executeQuery".`,
      }),
    };
  } catch (error) {
    console.error("Handler error:", error, "timings so far:", timings);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timingsMs: finalizeTimings(timings, handlerStart),
      }),
    };
  }
};

function finalizeTimings(timings, handlerStart) {
  timings.totalHandlerMs = Date.now() - handlerStart;
  return timings;
}

// Additive export, purely for reuse by ai/mcpServer -- nothing above this
// line changes behavior for the existing Lambda entry point (exports.handler).
Object.assign(exports, {
  setupConnection,
  performGetSchemas,
  performGetFieldValues,
  performExecuteQuery,
  ToolInputError,
});

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
      } else if (typeof value === "string") {
        cleaned[key] = repairMojibake(value);
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
