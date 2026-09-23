// Replaces Celigo for populating the SPP data CSVs in S3. Reads a per-
// company master config file describing which SPP tables/fields to sync,
// pulls only what changed since the last successful run (via SPP's XML API,
// filtered on "updated" so both new records AND edits to old-but-still-
// active records are caught -- see the design discussion this came out of),
// and merges the results into a single CSV per table using DuckDB.
//
// Deliberately writes to a NEW S3 path (spp-data/{company}/sync/{table}.csv)
// rather than the existing recent/historical files Celigo currently
// populates -- this can be built and validated in full isolation from the
// working production pipeline. Cutting aiQueryReports/index.js's
// REPORT_VIEWS over to read from here instead is a separate, deliberate
// step for later, not bundled into this.
//
// Known, accepted gap (per direct instruction): no periodic full
// reconciliation pass. An "updated"-based incremental sync can never detect
// a record that gets hard-purged after SPP's own (unpublished, ~30+ day)
// soft-delete retention window -- that gap is accepted for now rather than
// solved here.

const fs = require("fs");
const { DuckDBInstance } = require("@duckdb/node-api");
const { XMLParser } = require("fast-xml-parser");
const {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

const BUCKET = "topstep-ai-offering";
const DATA_PREFIX = "spp-data";
const WATERMARKS_TABLE = process.env.WATERMARKS_TABLE || "sppSyncWatermarks";
const PAGE_SIZE = 1000;

// Every table gets "id" in its SPP field list regardless of what's in the
// master config -- required by the merge step below. "deleted" is NOT a
// requestable field value (confirmed empirically: even querying
// deleted="1" for records known to be deleted, no <deleted> element comes
// back at all) -- deletion status is purely a query-mode thing (which
// combination of deleted="1"/include_nondeleted="1" you used), not a
// per-row field. It's computed separately in fetchDeletedIds() below and
// merged in as a synthetic column, not requested via _Return.
const ALWAYS_INCLUDED_SPP_FIELDS = ["id"];
const DELETED_CSV_FIELD = "deleted";

function s3Path(company, ...parts) {
  return `s3://${BUCKET}/${DATA_PREFIX}/${company}/${parts.join("/")}`;
}

async function getSsmParam(name) {
  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  return result.Parameter.Value;
}

// --- DuckDB setup (same pattern as aiQueryReports/index.js) ---------------

async function setupDuckDB(region) {
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
  return connection;
}

// --- Master config -----------------------------------------------------

// Reads spp-data/{company}/_config/master.csv and groups rows by
// localTable. Each group: { sppType, fields: [{sppField, subKey, csvField}] }.
//
// sppField may carry a dotted sub-path (e.g. "addr.city") to pull one named
// piece out of a compound field -- SPP always returns the WHOLE nested
// object for a compound field (confirmed for both dates and addresses, via
// Postman), there's no way to ask it for just one sub-part server-side, so
// "addr" is still what gets requested from SPP; "city" just says which
// piece of the response to extract client-side. See extractSubFieldValue.
// A plain sppField with no dot (subKey undefined) is unaffected by this --
// same single string as before, same flattenFieldValue call site.
async function readMasterConfig(connection, company) {
  const path = s3Path(company, "_config", "master.csv");
  const reader = await connection.runAndReadAll(
    `SELECT company, localTable, sppType, sppField, csvField FROM read_csv_auto('${path}', header=true);`,
  );
  const rows = await reader.getRowObjects();

  const byTable = {};
  for (const row of rows) {
    if (!byTable[row.localTable]) {
      byTable[row.localTable] = { sppType: row.sppType, fields: [] };
    }
    // "deleted" isn't a real requestable field (see DELETED_CSV_FIELD's
    // comment) -- drop it here if someone's master file lists it, rather
    // than sending SPP a field name that silently returns nothing.
    if (row.sppField === DELETED_CSV_FIELD) continue;

    const dotIndex = row.sppField.indexOf(".");
    const sppField = dotIndex === -1 ? row.sppField : row.sppField.slice(0, dotIndex);
    const subKey = dotIndex === -1 ? undefined : row.sppField.slice(dotIndex + 1);

    byTable[row.localTable].fields.push({
      sppField,
      subKey,
      csvField: row.csvField,
    });
  }

  // Always include "id", whether or not the master file explicitly lists
  // it -- required by the merge step below.
  for (const table of Object.values(byTable)) {
    for (const required of ALWAYS_INCLUDED_SPP_FIELDS) {
      const alreadyPresent = table.fields.some((f) => f.sppField === required);
      if (!alreadyPresent) {
        table.fields.push({ sppField: required, csvField: required });
      }
    }
  }

  return byTable;
}

// --- Watermarks -----------------------------------------------------------

function watermarkKey(integrationKey, localTable) {
  return `${integrationKey}#${localTable}`;
}

// Epoch used when no watermark exists yet -- effectively "everything",
// giving a full load on a table's first-ever run.
const EPOCH_START = { year: 2000, month: 1, day: 1 };

async function getWatermark(integrationKey, localTable) {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: WATERMARKS_TABLE,
      Key: marshall({ pk: watermarkKey(integrationKey, localTable) }),
    }),
  );
  if (!result.Item) return EPOCH_START;
  const item = unmarshall(result.Item);
  const d = new Date(item.lastSyncedAt * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

async function setWatermark(integrationKey, localTable, epochSeconds) {
  await dynamo.send(
    new PutItemCommand({
      TableName: WATERMARKS_TABLE,
      Item: marshall({
        pk: watermarkKey(integrationKey, localTable),
        lastSyncedAt: epochSeconds,
        updatedAt: Math.floor(Date.now() / 1000),
      }),
    }),
  );
}

// --- XML request/response ---------------------------------------------

// deletedMode: "nondeleted-only" (default, omit both attributes -- matches
// normal SPP UI behavior), "both" (deleted="1" include_nondeleted="1"), or
// "deleted-only" (deleted="1" alone).
function buildReadXml({ apiKey, accessToken, sppType, sppFieldNames, watermark, start, deletedMode }) {
  const returnFields = sppFieldNames.map((f) => `<${f}/>`).join("");
  const deletedAttrs =
    deletedMode === "both"
      ? ` deleted="1" include_nondeleted="1"`
      : deletedMode === "deleted-only"
        ? ` deleted="1"`
        : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<request API_version="1.0" client="RW Manager" client_ver="1.0" namespace="default" key="${apiKey}">
  <Auth>
    <Login>
      <access_token>${accessToken}</access_token>
    </Login>
  </Auth>
  <Read type="${sppType}" method="all" filter="newer-than" field="updated"${deletedAttrs} limit="${start},${PAGE_SIZE}">
    <Date>
      <year>${watermark.year}</year>
      <month>${String(watermark.month).padStart(2, "0")}</month>
      <day>${String(watermark.day).padStart(2, "0")}</day>
    </Date>
    <_Return>${returnFields}</_Return>
  </Read>
</request>`;
}

// SPP wraps every date-typed field's value in a nested <Date> element with
// year/month/day plus hour/minute/second/timezone (confirmed empirically --
// e.g. <updated><Date><year>2015</year><month>02</month>...</Date></updated>).
// The audit fields (created/updated) carry real time-of-day; a plain
// business "date" field has those sub-elements present but empty. Flatten
// either shape to "YYYY-MM-DD" (no time component) or "YYYY-MM-DD
// HH:MM:SS" (time component present).
//
// Non-date fields are coerced to a string (or left null/undefined) rather
// than passed through as-is: fast-xml-parser auto-converts numeric-looking
// XML text to real JS numbers, but an empty element for that same field on
// another record comes through as "" -- writing that mix straight into the
// batch JSON gives DuckDB's read_json_auto a column with both numbers and
// strings, and it infers a numeric type from its early sample then fails
// to cast the "" it hits later in a large batch. Forcing every value to a
// string keeps every column uniformly VARCHAR in the JSON, matching how
// mergeIntoS3Csv already treats everything as text.
function flattenFieldValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return String(value);

  const dateObj = value.Date ?? value;
  const year = dateObj.year ?? dateObj.Year;
  const month = dateObj.month ?? dateObj.Month;
  const day = dateObj.day ?? dateObj.Day;
  if (year === undefined || month === undefined || day === undefined) {
    // Unrecognized nested shape -- don't silently drop data, but don't
    // crash the whole sync over one odd field either.
    return JSON.stringify(value);
  }

  const datePart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hour = dateObj.hour ?? dateObj.Hour;
  const minute = dateObj.minute ?? dateObj.Minute;
  const second = dateObj.second ?? dateObj.Second;
  if (hour === "" || hour === undefined) return datePart;

  return `${datePart} ${String(hour).padStart(2, "0")}:${String(minute || 0).padStart(2, "0")}:${String(second || 0).padStart(2, "0")}`;
}

// Pulls one named piece out of a compound field's nested value -- e.g.
// addr -> <addr><Address><city>...</city>...</Address></addr>, so
// extractSubFieldValue(rawRow.addr, "city") drills into the single nested
// wrapper (whatever it's called -- "Address" here, generic rather than
// hardcoded since other compound field types may wrap under a different
// name) and returns that one sub-value. Entirely separate from, and never
// called in place of, flattenFieldValue -- a field with no subKey (every
// master.csv row before this feature, and every date field regardless)
// still goes through flattenFieldValue exactly as before.
function extractSubFieldValue(value, subKey) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return String(value);

  const keys = Object.keys(value);
  const wrapper =
    keys.length === 1 && typeof value[keys[0]] === "object" && value[keys[0]] !== null
      ? value[keys[0]]
      : value;

  const raw = wrapper[subKey];
  if (raw === null || raw === undefined) return raw;
  if (typeof raw !== "object") return String(raw);
  // A sub-field that's itself compound (unexpected) -- don't silently drop
  // data, but don't try to guess how to flatten it either.
  return JSON.stringify(raw);
}

const xmlParser = new XMLParser();

// Runs one paginated Read against SPP, returning the raw parsed rows
// (before field flattening/renaming) -- shared by fetchAllPages and
// fetchDeletedIds below.
async function fetchAllPagesRaw({ xmlUrl, apiKey, accessToken, sppType, sppFieldNames, watermark, deletedMode }) {
  const rawRows = [];
  let start = 0;

  while (true) {
    const xml = buildReadXml({ apiKey, accessToken, sppType, sppFieldNames, watermark, start, deletedMode });

    const response = await fetch(xmlUrl, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`SPP XML request failed [${response.status}]: ${responseText}`);
    }

    const parsed = xmlParser.parse(responseText);
    const pageData = parsed?.response?.Read?.[sppType];
    const pageRows = pageData === undefined ? [] : Array.isArray(pageData) ? pageData : [pageData];

    rawRows.push(...pageRows);

    if (pageRows.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }

  return rawRows;
}

// Separate query for just the set of deleted ids matching the same
// watermark -- "deleted" isn't a requestable field value (see
// DELETED_CSV_FIELD's comment), so this is the only way to know which ids
// among a changed set are deleted.
async function fetchDeletedIds({ xmlUrl, apiKey, accessToken, sppType, watermark }) {
  const rawRows = await fetchAllPagesRaw({
    xmlUrl, apiKey, accessToken, sppType, watermark,
    sppFieldNames: ["id"],
    deletedMode: "deleted-only",
  });
  return new Set(rawRows.map((r) => String(r.id)));
}

async function fetchAllPages({ xmlUrl, apiKey, accessToken, sppType, fields, watermark }) {
  // Dedupe -- several fields can share the same base sppField (e.g.
  // addr.city and addr.state both come from requesting "addr" once), so
  // request each base field from SPP only once regardless of how many
  // csvFields extract pieces from it.
  const sppFieldNames = [...new Set(fields.map((f) => f.sppField))];

  const [rawRows, deletedIds] = await Promise.all([
    fetchAllPagesRaw({ xmlUrl, apiKey, accessToken, sppType, sppFieldNames, watermark, deletedMode: "both" }),
    fetchDeletedIds({ xmlUrl, apiKey, accessToken, sppType, watermark }),
  ]);

  const rows = [];
  for (const rawRow of rawRows) {
    const csvRow = {};
    for (const field of fields) {
      csvRow[field.csvField] = field.subKey
        ? extractSubFieldValue(rawRow[field.sppField], field.subKey)
        : flattenFieldValue(rawRow[field.sppField]);
    }
    csvRow[DELETED_CSV_FIELD] = deletedIds.has(String(rawRow.id)) ? "1" : "0";
    rows.push(csvRow);
  }

  return rows;
}

// --- Merge into S3 (DuckDB-based upsert by id) -----------------------------

async function mergeIntoS3Csv(connection, company, localTable, fields, newRows) {
  const outputPath = s3Path(company, "sync", `${localTable}.csv`);

  if (newRows.length === 0) {
    // Nothing changed -- leave the file untouched rather than doing a
    // pointless read/rewrite. Still report its real row count so callers
    // don't read "rowsWritten: 0" as "the file is now empty".
    let rowsWritten = 0;
    try {
      const reader = await connection.runAndReadAll(
        `SELECT COUNT(*) AS n FROM read_csv_auto('${outputPath}', header=true);`,
      );
      rowsWritten = Number((await reader.getRowObjects())[0].n);
    } catch {
      // No existing file yet -- genuinely 0 rows.
    }
    return { rowsWritten, wasFirstLoad: false };
  }

  // fields lists only real SPP-requestable fields -- "deleted" is synthetic
  // (populated by fetchAllPages via a separate deleted-ids query, see
  // DELETED_CSV_FIELD's comment) and isn't in that list, so it's added here.
  const columns = [...fields.map((f) => f.csvField), DELETED_CSV_FIELD];
  // Everything cast to VARCHAR at this layer -- existing_data (read via
  // read_csv_auto) and new_batch (read via read_json_auto) can each infer
  // different types for the same column (e.g. INTEGER vs DOUBLE), which
  // would break the UNION ALL/anti-join below. Storing as text and letting
  // aiQueryReports' own read_csv_auto (sample_size=-1) do type inference on
  // the READ side keeps this consistent with how every other CSV in this
  // pipeline is already handled.
  const columnList = columns.map((c) => `CAST("${c}" AS VARCHAR) AS "${c}"`).join(", ");

  // Stage the new batch as its own table via a local temp file + DuckDB's
  // JSON ingestion -- avoids hand-writing CSV-escaping logic ourselves.
  // (DuckDB's httpfs extension doesn't support data: URIs, so this can't
  // be inlined without a real file.)
  const batchFile = `/tmp/new_batch_${localTable}_${Date.now()}.json`;
  fs.writeFileSync(batchFile, JSON.stringify(newRows));
  await connection.run(
    `CREATE OR REPLACE TABLE new_batch AS SELECT ${columnList} FROM read_json_auto('${batchFile}');`,
  );
  fs.unlinkSync(batchFile);

  // Master.csv can gain new columns over time (e.g. adding an addr.email
  // row to an already-synced table) -- the existing S3 file won't have
  // that column yet. Inspect its ACTUAL schema first via DESCRIBE rather
  // than assuming it matches the current column list: reading it with a
  // column list that references a column it doesn't have throws a Binder
  // Error, and treating that the same as "file doesn't exist" (as this
  // used to) silently discards every previously-synced row the very first
  // time a field gets added -- confirmed happening in production. A column
  // present in the current schema but missing from the old file gets
  // NULL-filled here instead, so old rows survive and self-heal the next
  // time each one is re-synced for real.
  let existingExists = true;
  try {
    const describeReader = await connection.runAndReadAll(
      `DESCRIBE SELECT * FROM read_csv_auto('${outputPath}', header=true);`,
    );
    const existingColumns = new Set(
      (await describeReader.getRowObjects()).map((r) => r.column_name),
    );
    const existingColumnList = columns
      .map((c) =>
        existingColumns.has(c)
          ? `CAST("${c}" AS VARCHAR) AS "${c}"`
          : `NULL AS "${c}"`,
      )
      .join(", ");
    await connection.run(
      `CREATE OR REPLACE TABLE existing_data AS SELECT ${existingColumnList} FROM read_csv_auto('${outputPath}', header=true);`,
    );
  } catch {
    existingExists = false;
  }

  if (existingExists) {
    // New batch always wins for any id it contains -- it's a fresher pull
    // than whatever's already on disk for that id. Anti-join rather than
    // "id NOT IN (...)" so a stray NULL id in either table can't collapse
    // the whole filter to empty via SQL's three-valued NOT IN semantics.
    await connection.run(`
      CREATE OR REPLACE TABLE merged AS
      SELECT existing_data.* FROM existing_data
      LEFT JOIN new_batch ON existing_data.id = new_batch.id
      WHERE new_batch.id IS NULL
      UNION ALL
      SELECT * FROM new_batch;
    `);
  } else {
    await connection.run(`CREATE OR REPLACE TABLE merged AS SELECT * FROM new_batch;`);
  }

  await connection.run(`COPY merged TO '${outputPath}' (FORMAT CSV, HEADER);`);

  const reader = await connection.runAndReadAll(`SELECT COUNT(*) AS n FROM merged;`);
  const rows = await reader.getRowObjects();

  return { rowsWritten: Number(rows[0].n), wasFirstLoad: !existingExists };
}

// --- Handler ----------------------------------------------------------

exports.handler = async (event) => {
  const {
    integrationKey, // e.g. "spp-top step-prod" -- picks the exact oauth_config/oauth_tokens row. Not derived from `company` -- see the README note on why.
    instance, // "sandbox" | "production" -- picks which SPP XML endpoint/API key to use
    company, // which spp-data/{company}/_config/master.csv to read
    table, // optional -- sync just this one localTable instead of every table in the master config
  } = event;

  if (!integrationKey || !instance || !company) {
    return { statusCode: 400, body: { error: "integrationKey, instance, and company are required" } };
  }

  const region = process.env.AWS_REGION || "us-east-2";
  const runStartedAt = Math.floor(Date.now() / 1000);

  const [apiKey, xmlUrl, { getValidAccessToken }] = await Promise.all([
    getSsmParam(instance === "sandbox" ? "/spp/sandboxKey" : "/spp/productionKey"),
    getSsmParam(instance === "sandbox" ? "/spp/sandboxXMLURL" : "/spp/productionXMLURL"),
    import("./oauthUtils.mjs"),
  ]);
  const accessToken = await getValidAccessToken(integrationKey);

  const connection = await setupDuckDB(region);
  const masterConfig = await readMasterConfig(connection, company);

  const tablesToRun = table ? [table] : Object.keys(masterConfig);
  const succeeded = [];
  const failed = [];

  for (const localTable of tablesToRun) {
    const tableConfig = masterConfig[localTable];
    if (!tableConfig) {
      failed.push({ table: localTable, error: "Not found in master config" });
      continue;
    }

    try {
      const watermark = await getWatermark(integrationKey, localTable);

      const rows = await fetchAllPages({
        xmlUrl,
        apiKey,
        accessToken,
        sppType: tableConfig.sppType,
        fields: tableConfig.fields,
        watermark,
      });

      const { rowsWritten, wasFirstLoad } = await mergeIntoS3Csv(
        connection,
        company,
        localTable,
        tableConfig.fields,
        rows,
      );

      await setWatermark(integrationKey, localTable, runStartedAt);

      succeeded.push({ table: localTable, newOrChangedRows: rows.length, totalRowsAfterMerge: rowsWritten, wasFirstLoad });
      console.log(`[sppDataSync] "${localTable}": ${rows.length} new/changed rows, ${rowsWritten} total after merge`);
    } catch (error) {
      console.error(`[sppDataSync] "${localTable}" failed:`, error);
      failed.push({ table: localTable, error: error.message });
      // Deliberately not re-thrown -- one bad table shouldn't abort the
      // rest of the run, and its watermark is left untouched so the next
      // run retries from the same point.
    }
  }

  return {
    statusCode: failed.length > 0 && succeeded.length === 0 ? 500 : 200,
    body: { succeeded, failed },
  };
};

// Exposed only for local/manual test scripts to exercise individual pieces
// against real SPP data without going through the full handler (which
// requires the watermarks table and a real S3 master config to exist).
// Lambda only ever invokes exports.handler -- this is inert in production.
exports._internal = {
  buildReadXml,
  flattenFieldValue,
  extractSubFieldValue,
  fetchAllPagesRaw,
  fetchDeletedIds,
  fetchAllPages,
  mergeIntoS3Csv,
  readMasterConfig,
  getWatermark,
  setWatermark,
  setupDuckDB,
};
