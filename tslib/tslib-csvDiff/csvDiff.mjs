/**
 * csvDiff.mjs
 *
 * Compares an original CSV loadfile against a revised one and returns a
 * structured diff object broken out by phase, task, and assignment.
 *
 * Expected invocation (e.g. from your orchestrating Lambda or S3 trigger):
 *   event = { originalCsv: "<raw csv string>", newCsv: "<raw csv string>" }
 *
 * Returns:
 *   {
 *     phases:      { added: [], deleted: [] },
 *     tasks:       { added: [], deleted: [], modified: [] },
 *     assignments: { added: [], deleted: [], modified: [] }
 *   }
 */

// ─── Field definitions ────────────────────────────────────────────────────────

// ─── CSV parser ───────────────────────────────────────────────────────────────

/**
 * Minimal CSV parser that handles quoted fields (including embedded commas
 * and newlines).  Returns an array of objects keyed by the header row.
 */
function parseCsv(text) {
  const lines = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Handle escaped double-quotes ("")
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else if (ch === "\r" && !inQuotes) {
      // skip CR
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);

  const splitLine = (line) => {
    const fields = [];
    let field = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = !inQ;
      } else if (ch === "," && !inQ) {
        fields.push(field.trim());
        field = "";
      } else {
        field += ch;
      }
    }
    fields.push(field.trim());
    return fields;
  };

  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strips currency formatting so "6,150" and "6150" compare equal.
 * Preserves the original string for non-numeric fields.
 */
function normalizeValue(val) {
  if (val === undefined || val === null) return "";
  const str = String(val).trim();
  // Remove commas from numbers, handle " - " style zero placeholders
  const stripped = str.replace(/,/g, "").replace(/^\s*-\s*$/, "0");
  return isNaN(stripped) || stripped === "" ? str : stripped;
}

/**
 * Returns true if the row looks like the summary/total line at the bottom
 * (no Unit Number, no Header, just a total in the last column).
 */
function isSummaryRow(row) {
  return !row["Unit Number"] && !row["Header"] && !row["Bid Role"];
}

/**
 * Parse all rows and return separate Maps for tasks and assignments,
 * plus a Set of phase names.
 *
 * taskMap:       unitNumber           → first row for that task
 * assignmentMap: unitNumber||bidRole  → row
 * phaseSet:      Set of Header values
 */
function buildMaps(rows, fieldDefinitions) {
  const fieldMaps = [];

  for (const fieldDef of fieldDefinitions) {
    const fieldMap = new Map();
    const isComposite = Array.isArray(fieldDef.key);

    for (const row of rows) {
      if (isSummaryRow(row)) continue;

      const rowKey = isComposite
        ? fieldDef.key.map((k) => row[k]).join("|") // "1.01|Sr. Manager"
        : row[fieldDef.key]; // "PHASE ONE"

      if (!fieldMap.has(rowKey)) {
        fieldMap.set(rowKey, row);
      }
    }

    fieldMaps.push({ entity: fieldDef.entity, fieldMap: fieldMap });
  }

  return fieldMaps;
}

/**
 * Diff two Maps on a specified set of fields.
 * Returns { added, deleted, modified }.
 */
function diffMaps(originalMap, newMap, fields, uniqueKey) {
  const added = [];
  const deleted = [];
  const modified = [];

  const isComposite = Array.isArray(uniqueKey);
  const keyLabel = isComposite ? uniqueKey.join("|") : uniqueKey;

  for (const [key, newRow] of newMap) {
    if (!originalMap.has(key)) {
      added.push({ [keyLabel]: key, row: newRow });
    } else {
      const origRow = originalMap.get(key);
      const changes = {};
      for (const field of fields) {
        const origVal = normalizeValue(origRow[field]);
        const newVal = normalizeValue(newRow[field]);
        if (origVal !== newVal) {
          changes[field] = { from: origVal, to: newVal };
        }
      }
      if (Object.keys(changes).length > 0) {
        modified.push({ [keyLabel]: key, changes, row: newRow });
      }
    }
  }

  for (const [key, origRow] of originalMap) {
    if (!newMap.has(key)) {
      deleted.push({ [keyLabel]: key, row: origRow });
    }
  }

  return { added, deleted, modified };
}

// ─── Main diff logic ──────────────────────────────────────────────────────────

function diffCsvs(originalCsv, newCsv, fieldDefinitions) {
  const returnArray = [];
  const originalRows = parseCsv(originalCsv);
  const newRows = parseCsv(newCsv);

  const originalMaps = buildMaps(originalRows, fieldDefinitions);
  const updatedMaps = buildMaps(newRows, fieldDefinitions);

  for (const fieldDef of fieldDefinitions) {
    const originalMap = originalMaps.find(
      (m) => m.entity === fieldDef.entity,
    )?.fieldMap;
    const updatedMap = updatedMaps.find(
      (m) => m.entity === fieldDef.entity,
    )?.fieldMap;

    const entities = diffMaps(
      originalMap,
      updatedMap,
      fieldDef.fields,
      fieldDef.key,
    );

    returnArray.push({
      [fieldDef.entity]: {
        added: entities.added,
        deleted: entities.deleted,
        modified: entities.modified,
      },
    });
  }

  return returnArray;
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

export const handler = async (event) => {
  const { originalCsv, newCsv, fieldDefinitions } = event;

  if (!originalCsv || !newCsv || !fieldDefinitions) {
    return {
      statusCode: 400,
      body: {
        error: "OriginalCsv, NewCsv, and FieldDefinitions are required.",
      },
    };
  }

  const diff = diffCsvs(originalCsv, newCsv, fieldDefinitions);

  return {
    statusCode: 200,
    body: diff,
  };
};

// ─── Local test ───────────────────────────────────────────────────────────────

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}

async function test() {
  // Minimal inline CSVs that exercise every change type
  const originalCsv = `Project ID,Budget Category,Revenue Account,Team,Functional Area,Tab,Header,Unit Number,Unit Name,Unit Basis,# of Units,Bid Role,Total Hours,Total Cost,Total Bid
TestProject,Directs,4700,T1303,RegOps,1,PHASE ONE,1.01,Task Alpha,month,10,Sr. Manager,100,11200,19900
TestProject,Directs,4700,T1303,RegOps,1,PHASE ONE,1.01,Task Alpha,month,10,RegOps Associate,50,3124,6700
TestProject,Directs,4700,T1303,RegOps,1,PHASE ONE,1.02,Task Beta,month,5,Sr. Manager,40,4480,7960
TestProject,Directs,4700,T1303,RegOps,1,PHASE TWO,2.01,Task Gamma,site,4,CTL,20,2608,4940
TestProject,PT,49998,T1303,PT Cost,2,Pass Through,100,General Office,month,40,,, -   , -   
`;

  const newCsv = `Project ID,Budget Category,Revenue Account,Team,Functional Area,Tab,Header,Unit Number,Unit Name,Unit Basis,# of Units,Bid Role,Total Hours,Total Cost,Total Bid
TestProject,Directs,4700,T1303,RegOps,1,PHASE ONE,1.01,Task Alpha RENAMED,month,12,Sr. Manager,120,13440,23880
TestProject,Directs,4700,T1303,RegOps,1,PHASE ONE,1.01,Task Alpha RENAMED,month,12,RegOps Associate,50,3124,6700
TestProject,Directs,4700,T1303,RegOps,1,PHASE ONE,1.03,Task Delta NEW,month,3,Sr. Manager,30,3360,5970
TestProject,Directs,4700,T1303,RegOps,1,PHASE THREE,3.01,Task Epsilon,site,2,CTL,10,1304,2470
TestProject,PT,49998,T1303,PT Cost,2,Pass Through,100,General Office,month,40,,, -   , -   
`;

  const fieldDefinitions = [
    {
      entity: "Projecttask (Phase)",
      fields: [],
      key: "Header",
    },
    {
      entity: "Projecttask",
      fields: [
        "Budget Category",
        "Revenue Account",
        "Unit Name",
        "Unit Basis",
        "# of Units",
      ],
      key: "Unit Number",
    },
    {
      entity: "Projecttaskassign",
      fields: [
        "Team",
        "Functional Area",
        "Total Hours",
        "Total Cost",
        "Total Bid",
      ],
      key: ["Unit Number", "Bid Role"],
    },
  ];
  const result = await handler({ originalCsv, newCsv, fieldDefinitions });
  console.log(JSON.stringify(result, null, 2));
}
