# tslib-getRecords

Reads records from the SPP (Project Pulse) API by record type and filter criteria, with optional related-field "lookups" merged onto each result.

## How to call it

From another Lambda, use the shared helper:

```javascript
const records = await callSharedUtil("tslib-getRecords", {
  authObj: { company: "Tempus Sandbox", instance: "sandbox" },
  recordType: "Projecttask",
  criteriaObj: { id: 6 },
  limit: 1,
});
```

`callSharedUtil` unwraps the response for you — `records` is the `body` array directly (see "Return value" below).

## Input parameters

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `authObj` | object | yes | `{ company, instance }`. `instance` of `"sb"` or `"sandbox"` (case-insensitive) routes to the sandbox environment; anything else routes to production. |
| `recordType` | string | yes | The SPP record type to read, e.g. `"Projecttask"`, `"Projecttaskassign"`, `"Customer"`. |
| `criteriaObj` | object | yes | Field/value pairs used to filter the records (see "Criteria values" below). |
| `limit` | number | yes | Max number of records SPP should return. |
| `fields` | string | no | Comma-separated list of field names to return (e.g. `"id,name,externalid"`). If omitted, SPP returns its default field set. |
| `lookups` | array | no | Enriches each returned record with a value from a related table. See "Lookups" below. |

### Criteria values

Each entry in `criteriaObj` can be either:

- **A primitive** (string/number) — filters directly on that field:
  ```javascript
  criteriaObj: { id: 6 }
  ```

- **A lookup object** — resolves to an id by querying another table first, then filters on that resolved id. Useful when you know a name/external id but the SPP field expects an internal id:
  ```javascript
  criteriaObj: {
    userid: {
      value: "Sr. Data Manager",
      lookupBy: "name",      // field to match on in the lookup table
      inTable: "User",       // table to look up
      returnField: "id",     // optional, defaults to "id"
    },
  }
  ```
  This is equivalent to first finding the `User` whose `name` is `"Sr. Data Manager"`, then filtering `userid` by that user's `id`. If no match is found, that criterion is silently omitted.

### Lookups

`lookups` lets you pull a related field onto each result row without a separate call:

```javascript
lookups: [
  { inTable: "Customer", returnField: "name", idFieldInData: "customerid" },
  { inTable: "Project", returnField: "name", idFieldInData: "projectid" },
]
```

For each returned record, this adds:
- `record["Customer_name"]` — the `name` of the `Customer` whose `id` matches `record.customerid`
- `record["Project_name"]` — the `name` of the `Project` whose `id` matches `record.projectid`

Repeated lookups for the same `(inTable, returnField, idFieldInData, idValue)` combination are cached within a single invocation, so looking up the same customer/project across many rows only hits SPP once per unique value.

## Return value

```javascript
{
  statusCode: 200,
  logs: [...],
  body: [ /* array of record objects, possibly empty */ ]
}
```

`body` is **always an array**, even if SPP returns zero or one matching record. When called via `callSharedUtil`, you receive `body` directly, so:

```javascript
const records = await callSharedUtil("tslib-getRecords", { ... });
const first = records?.[0]; // first matching record, or undefined if none found
```

On failure, `statusCode` is `500` (or SPP's HTTP status) and `body` is `{ error: "..." }`.

## Examples

**Get a single record by id, with related fields:**
```javascript
const records = await callSharedUtil("tslib-getRecords", {
  authObj: { company: "Tempus Sandbox", instance: "sandbox" },
  recordType: "Projecttask",
  criteriaObj: { id: 6 },
  limit: 1,
  lookups: [
    { inTable: "Customer", returnField: "name", idFieldInData: "customerid" },
    { inTable: "Project", returnField: "name", idFieldInData: "projectid" },
  ],
});
const task = records[0];
console.log(task.Customer_name, task.Project_name);
```

**Filter using a lookup-resolved criterion:**
```javascript
const records = await callSharedUtil("tslib-getRecords", {
  authObj: { company: "Tempus Sandbox", instance: "sandbox" },
  recordType: "Projecttaskassign",
  criteriaObj: {
    projecttaskid: 2881,
    userid: {
      value: "Sr. Data Manager",
      lookupBy: "name",
      inTable: "User",
    },
  },
  limit: 1,
});
```
