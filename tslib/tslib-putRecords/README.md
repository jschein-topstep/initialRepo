# tslib-putRecords

Adds or modifies records in the SPP (Project Pulse) API. Whether a record is added or modified is determined automatically based on whether you include an `id`.

## How to call it

```javascript
const result = await callSharedUtil("tslib-putRecords", {
  authObj: { company: "Tempus Sandbox", instance: "SB" },
  recordType: "Projecttask",
  writeObj: {
    projectid: 176,
    name: "RegOps Management & Oversight",
    id_number: "1.02",
    externalid: "proj176_task0",
  },
});
```

## Input parameters

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `authObj` | object | yes | `{ company, instance }`. `instance` of `"sb"` or `"sandbox"` (case-insensitive) routes to the sandbox environment; anything else routes to production. |
| `recordType` | string | yes | The SPP record type to write, e.g. `"Projecttask"`, `"Category"`. |
| `writeObj` | object or array | yes | One record (object) or multiple records (array of objects) to add/modify. |

### Add vs. Modify

For each object in `writeObj`:
- If it has an `id` key, SPP performs a **Modify** on that record.
- If it does **not** have an `id` key, SPP performs an **Add** (creates a new record).

### Field values

Most fields are written as plain values:

```javascript
writeObj: {
  projectid: 176,
  name: "Some task name",
  id_number: "1.02",
  unit_basis__c: "month",
  number_units__c: "13",
}
```

#### `date` fields

A field named `date` accepts an `"YYYY-MM-DD"` string (or anything `new Date()` can parse) and is converted to SPP's `<Date>` element automatically:

```javascript
writeObj: {
  date: "2026-06-15",
  ...
}
```

#### Lookup-based fields

If a field's value is an object, it's treated as a reference to another record rather than a literal value:

```javascript
writeObj: {
  parentid: {
    value: "proj176_phase0",
    lookupBy: "externalid",
    inTable: "Projecttask",
  },
  default_category: {
    value: "4700 - HLS revenue",
    lookupBy: "name",
    inTable: "Category",
  },
}
```

There are two flavors:

- **`lookupBy: "externalid"`** — written directly as an `external` attribute reference (no extra API call):
  ```xml
  <parentid external="Projecttask">proj176_phase0</parentid>
  ```

- **Any other `lookupBy`** (e.g. `"name"`) — the function looks up the matching record in `inTable` (where `[lookupBy] == value`) via `tslib-getRecords`, and writes that record's `id`:
  ```javascript
  default_category: {
    value: "4700 - HLS revenue", // looks up Category where name == "4700 - HLS revenue"
    lookupBy: "name",
    inTable: "Category",
  }
  ```
  If multiple records share the same `(inTable, lookupBy, value)`, the lookup is only performed once per call and the resolved id is reused for subsequent records in the same `writeObj` array. If no matching record is found, the field is omitted from the write.

### Writing multiple records in one call

```javascript
writeObj: [
  { projectid: 176, name: "Task 1", externalid: "proj176_task0" },
  { projectid: 176, name: "Task 2", externalid: "proj176_task1" },
]
```
Each object is processed independently (its own Add/Modify decision and its own lookups), and all are sent to SPP in a single request.

## Return value

```javascript
{
  statusCode: 200,
  logs: [...],
  headers: { "Content-Type": "application/json" },
  body: { /* the added/modified record as returned by SPP */ }
}
```

`body` corresponds to SPP's `Add` or `Modify` response for `recordType`. **Note:** unlike `tslib-getRecords`, `body` here is a single object, not an array — even when `writeObj` was an array of multiple records, SPP's combined response is what's returned as-is.

On failure, `statusCode` is `500` (or SPP's HTTP status) and `body` is `{ error: "..." }` (or a JSON string with SPP error details for non-2xx SPP responses).

## Example

```javascript
const result = await callSharedUtil("tslib-putRecords", {
  authObj: { company: "Tempus Sandbox", instance: "SB" },
  recordType: "Projecttask",
  writeObj: [
    {
      projectid: 176,
      name: "RegOps Management & Oversight Through Last Site Activated",
      parentid: {
        value: "proj176_phase0",
        lookupBy: "externalid",
        inTable: "Projecttask",
      },
      default_category: {
        value: "4700 - HLS revenue",
        lookupBy: "name",
        inTable: "Category",
      },
      id_number: "1.02",
      unit_basis__c: "month",
      number_units__c: "13",
      externalid: "proj176_task0",
    },
  ],
});
```
