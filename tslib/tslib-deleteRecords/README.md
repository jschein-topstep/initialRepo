# tslib-deleteRecords

Deletes records from the SPP (Project Pulse) API. Records can be specified directly by id, or indirectly by criteria that get resolved to ids first.

## How to call it

```javascript
const result = await callSharedUtil("tslib-deleteRecords", {
  authObj: { company: "Tempus Sandbox", instance: "sb" },
  recordType: "Projecttaskassign",
  recordsToDelete: [
    { projecttaskid: 2877 },
    { projecttaskid: 2878 },
  ],
});
```

## Input parameters

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `authObj` | object | yes | `{ company, instance }`. `instance` of `"sb"` or `"sandbox"` (case-insensitive) routes to the sandbox environment; anything else routes to production. |
| `recordType` | string | yes | The SPP record type to delete from, e.g. `"Projecttaskassign"`. |
| `recordsToDelete` | array (or single item) | yes | Describes which records to delete. See "Specifying records" below. |

### Specifying records

Each entry in `recordsToDelete` can take one of these forms:

- **A raw id** (number or string) — deletes that record id directly:
  ```javascript
  recordsToDelete: [232, 233]
  ```

- **An object with an `id` key** — deletes that record id directly:
  ```javascript
  recordsToDelete: [{ id: 232 }]
  ```

- **An object with one or more other key/value pairs** — each pair is treated as a filter. The function looks up *all* records of `recordType` matching `field == value` (up to 1000) and deletes every match:
  ```javascript
  recordsToDelete: [
    { projecttaskid: 2877 },
    { projecttaskid: 2878 },
  ]
  ```
  This is useful when you want to delete "every assignment for task 2877" without knowing the individual record ids ahead of time.

A single object (not wrapped in an array) is also accepted:
```javascript
recordsToDelete: { projecttaskid: 2877 }
```

> **Not yet supported:** lookup-style values (objects like `{ value, lookupBy, inTable }`, similar to `tslib-getRecords`/`tslib-putRecords` criteria) inside a `recordsToDelete` entry. This form is still under development — only raw ids, `{ id }`, and plain field/value filters are currently functional.

## Return value

```javascript
{
  statusCode: 200,
  logs: [...],
  headers: { "Content-Type": "application/json" },
  body: { /* SPP's Delete response */ }
}
```

On failure, `statusCode` is `500` (or SPP's HTTP status) and `body` is `{ error: "..." }` (or a JSON string with SPP error details for non-2xx SPP responses).

## Example

```javascript
const result = await callSharedUtil("tslib-deleteRecords", {
  authObj: { company: "Tempus Sandbox", instance: "sb" },
  recordType: "Projecttaskassign",
  recordsToDelete: [
    { projecttaskid: 2877 },
    { projecttaskid: 2878 },
  ],
});
```
