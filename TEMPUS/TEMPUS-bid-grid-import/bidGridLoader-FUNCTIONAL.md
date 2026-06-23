# Bid Grid Loader — Functional Documentation

**What this is:** An AWS Lambda function that ingests a **bid grid CSV** and uses it to build (or update) the **phases, tasks, task assignments, billing rules, and rolled-up financial totals** of a project in SuiteProjects Pro (SPP).

This document explains _what the code does and in what order_. It does not cover deployment (this function is a plain Node Lambda — no Docker).

---

## 1. The big picture

The function runs in one of **two modes**, chosen automatically based on whether the project has been loaded before:

| Mode                                           | When it runs                                        | What it does                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Initial load** (`newBidGridLoad`)            | Project has **no** `previousBidGridAttachmentId__c` | Wipes all existing tasks, rebuilds everything from the file, then computes unit prices and creates billing rules.                       |
| **Incremental update** (`updateBidGridValues`) | Project **has** a `previousBidGridAttachmentId__c`  | Reconstructs the project's _current_ state as a CSV, diffs it against the new file, and applies only the **adds / modifies / deletes**. |

In both modes, the actual writes to SPP happen in **bulk at the end** of the handler, not inside the mode functions. The mode functions just **fill three arrays** — `phaseObjArray`, `taskObjArray`, `assignmentObjArray` — which the handler then writes.

---

## 2. Input

The function is triggered with an event whose `body` is JSON containing a `fileId`:

```json
{ "fileId": 111 }
```

That `fileId` is the ID of an **Attachment record in SPP** — the uploaded bid grid CSV. The function fetches that attachment, base64-decodes it, and parses it into rows.

**Expected CSV columns** (header row):

```
Project ID, Budget Category, Revenue Account, Team, Functional Area, Tab,
Header, Unit Number, Unit Name, Unit Basis, # of Units, Bid Role,
total hours, Total Cost, Total Bid
```

Each row is one line of the bid grid. The meaning of the key columns:

- **Header** → the **phase** name (a row with a `Header` belongs under that phase).
- **Unit Number / Unit Name** → identify a **task** within the phase.
- **Bid Role** → if present, the row also defines a **task assignment** (a person/role assigned to that task).
- The financial/quantity columns (`# of Units`, `total hours`, `Total Cost`, `Total Bid`) feed both the records and the project-level rollups.

---

## 3. Core patterns to understand first

Three patterns recur throughout. Understanding them makes the rest obvious.

### a. `callSharedUtil("tslib-...", request)`

Every read/write to SPP goes through a shared utility layer (a Lambda Layer in prod, a relative import locally). The operations used here:

- `tslib-getRecords` — query records by `criteriaObj`.
- `tslib-putRecords` — create/update records (`writeObj` can be a single object or an array for bulk).
- `tslib-deleteRecords` — delete by IDs.
- `tslib-csvDiff` — diff two CSVs by entity (used only in update mode).

### b. `externalid` linking

New records are linked **before they exist in SPP** by assigning each a deterministic `externalid`, then referencing that externalid in child records. The patterns:

- Phase externalid: `proj{projectId}_phase{Header}`
- Task externalid: `proj{projectId}_task{Unit Number}`

A task points to its phase via `parentid: { value: <phaseExtId>, lookupBy: "externalid", inTable: "Projecttask" }`. An assignment points to its task the same way. This is **why write order matters** (see §5).

### c. In-memory record cache (`getSPPRecordFromStore`)

Used in update mode to avoid hammering SPP with repeated lookups for the same Category/Cost Center/Department/User/Phase. It checks a local `dataStore` array first; only on a miss does it query SPP, then caches the result.

---

## 4. Handler flow (top level)

The `handler` runs these steps in order:

1. **Parse input** — read `fileId` from `event.body`.
2. **Fetch the attachment** (`getAttachment`) and **base64-decode** it into CSV text.
3. **Parse the CSV** into `fileLines` (array of row objects keyed by column header).
4. **Look up the Project** by name, using `fileLines[0]["Project ID"]` as the project name.
5. **Seed the rollup object** `projectCalculations` — running financial totals. Several fields start at `inflation + discount` (`proj_inflation__c + proj_discount__c`) rather than zero.
6. **Choose a mode:**
   - If `projectRecord.previousBidGridAttachmentId__c` exists → `updateBidGridValues(...)` (incremental).
   - Otherwise → `newBidGridLoad(...)` (initial).
   - _Both populate the three object arrays; neither writes records itself._
7. **Bulk-write the records** that were collected, in this strict order:
   1. `phaseObjArray` → create phases
   2. `taskObjArray` → create/update tasks
   3. `assignmentObjArray` → create/update assignments
8. **Initial load only:** call `calculateUnitPricePer(projectId)` to compute per-unit pricing and create billing rules (see §7).
9. **Finalize the rollups** — compute gross-margin percentages, stamp `previousBidGridAttachmentId__c = fileId`.
10. **Update the Project record** with `projectCalculations`.

> The order in step 7 is deliberate: tasks reference phases by externalid, and assignments reference tasks by externalid, so the parent records must be created first for the externalid lookups to resolve.

---

## 5. Mode A — Initial load (`newBidGridLoad`)

Runs when the project has never been loaded.

1. **`deleteExistingTasks(projectId)`** — fetches all existing `Projecttask` records for the project and deletes them. This is a clean-slate rebuild. _(Note: this function still has a `// finish this` marker and returns nothing meaningful, but it does perform the delete.)_
2. **Walk each file line** that has a `Header`:
   - **Phase:** find an existing phase object by name in `phaseObjArray`; if none, create one (with its `proj..._phase...` externalid) and push it.
   - **Task:** find an existing task object by `Unit Name`; if none, create one mapping the CSV columns to SPP fields (team → Cost Center by name, revenue account → Category by name, parent → phase by externalid, units, basis, budget category, etc.) and push it. `unit_total_cost__c` / `unit_total_bid__c` are taken from the file here but **may be overridden later** by `calculateUnitPricePer` if the task has assignments.
   - **Assignment:** if the row has a `Bid Role`, create an assignment object (task by externalid, functional area → Department by name, bid role → User by name, hours, cost, bid) and push it.
   - **Accumulate** the row into `projectCalculations` (see §6).

Nothing is written to SPP inside this function — the handler does the bulk writes afterward.

---

## 6. Project total accumulation (`accumulateProjectTotals`)

Called once per file line (in both modes) to roll line-level numbers up to the project. For each row it:

- Always adds `total hours` to `proj_total_hours__c`.
- Branches on **Budget Category** and adds `Total Bid` / `Total Cost` into the matching buckets:
  - **Directs** → directs, total direct, contract value, direct cost, total cost, direct GM, project GM.
  - **PT** → PT, PT total, contract value, PT cost, total cost, project GM.
  - **Fees** → fees, PT total, contract value, PT cost, total cost, project GM.
  - **Investigator Grants** → IG, contract value, IG cost, total cost, project GM.

After the per-line loop, the handler computes the two margin percentages (`proj_direct_gm_percent__c`, `proj_project_gm_percent__c`), guarding against divide-by-zero.

---

## 7. Unit pricing & billing rules (`calculateUnitPricePer`) — initial load only

After records are written on an initial load, this recomputes pricing from the now-persisted data. For each **non-phase task** in the project:

1. Fetch its assignments.
2. Sum the assignments' `assign_bid__c` and `assign_cost__c`. If the task has **no** assignments, fall back to the task's own `unit_total_bid__c` / `unit_total_cost__c`.
3. Compute `unit_price_per__c = totalBid / number_units__c` (0 if no units).
4. **Update the task** with the recomputed bid total, cost total, and unit price.
5. **Create a billing rule** (`Projectbillingrule`, type `"T"`, `rate_from "U"`) for the task.
6. **Create an Uprate** linked to that billing rule carrying the unit price.

> Note: the Uprate uses a **hardcoded `userid: 251`**. If that user is environment-specific, it's a thing to watch when moving between instances. See §9.

---

## 8. Mode B — Incremental update (`updateBidGridValues`)

Runs when the project already has a `previousBidGridAttachmentId__c`. Instead of wiping and rebuilding, it figures out the **difference** between what's in SPP now and what the new file says, and applies only that.

1. **Reconstruct current state as CSV (`originalCsv`).** Read every current `Projecttask` for the project; for each, resolve its referenced records (Category, Cost Center, parent Phase, and per-assignment Department + User) via the cached `getSPPRecordFromStore`, and emit a CSV row per assignment (or one blank-assignment row if the task has none). The result is a CSV in the **same column layout as the input file**, representing the live state of the project.
2. **Diff** `originalCsv` (current state) against `newCsv` (the incoming file) using `tslib-csvDiff`, guided by `fieldDefinitions`, which declares for each entity:
   - **Phase** (`Projecttask (Phase)`) — keyed by `Header`.
   - **Task** (`Projecttask`) — keyed by `Unit Number`, comparing team, budget category, revenue account, name, basis, # of units.
   - **Assignment** (`Projecttaskassign`) — keyed by the composite **`Unit Number` + `Bid Role`**, comparing functional area, hours, cost, bid.
3. The diff returns `added` / `modified` / `deleted` per entity, dispatched to three handlers:
   - **`processPhaseUpdates`** — creates objects for **added** phases. Modified/deleted phases are intentionally **not** handled (a phase change surfaces as an add + a delete; see the inline comment).
   - **`processTaskUpdates`** — builds objects for **added and modified** tasks. Modified tasks include an `id` lookup (by externalid) so the write updates rather than inserts. **Deleted** tasks are **not yet implemented** — the loop only logs `"here"`.
   - **`processAssignmentUpdates`** — handles **deleted** assignments (resolve the task by `id_number`, then the assignment by task + user name, then delete it) and **added/modified** assignments (modified ones resolve the existing assignment `id` first so the write updates in place).
4. **Accumulate** project totals across all file lines, same as initial load.

As with initial load, this function only **populates the arrays**; the handler performs the writes.

---

## 9. Known gaps, quirks & things to watch

A maintainer should be aware of these. None are necessarily urgent, but they explain surprising behavior.

- **Deleted-task handling is a stub** (§8, `processTaskUpdates`): the `taskInfo.deleted` loop only does `console.log("here")`. If a task is removed from the bid grid on an update, it is **not** removed from SPP.
- **Modified/deleted phases are not handled** (§8, `processPhaseUpdates`): by design they appear as add/delete elsewhere, but verify this assumption holds for your data.
- **`deleteExistingTasks` is marked `// finish this`** and returns nothing — it deletes tasks but any intended follow-up cleanup (e.g. orphaned billing rules/assignments) isn't there.
- **Debug leftovers:** `origSnippet` / `newSnippet` (searching for `"F2F Meetings"`) are computed and never used; `phaseNames` is declared in the handler and unused. Safe to remove.
- **Project lookup is by name** using `fileLines[0]["Project ID"]` — note the column is literally named "Project ID" but holds the project **name**. A mismatched/renamed project will yield no `projectRecord` and the function will throw on `projectRecord.id`.
- **`unit_total_cost__c` / `unit_total_bid__c` from the file are provisional** on initial load — `calculateUnitPricePer` overrides them for any task that has assignments.
- **Local run:** the bottom `test()` shim runs `handler` with `fileId: 111` when not on Lambda. The `authObj` reads `COMPANY / USER / PASSWORD / INSTANCE` from the environment — make sure those are set locally, and note `USER` can collide with a system variable on some shells.

---

## 10. One-paragraph summary

Given a `fileId` pointing to a bid grid CSV attachment in SPP, the function loads and parses the CSV, finds the target project, and either (a) **initial load** — deletes existing tasks and rebuilds phases/tasks/assignments from the file, then computes per-unit pricing and creates billing rules; or (b) **incremental update** — reconstructs the project's current state as a CSV, diffs it against the new file, and applies only the added/modified/deleted phases, tasks, and assignments. In both cases it rolls line-level costs and bids up into project-level financial totals (contract value, costs, gross margins, hours) and writes those back to the Project record, stamping the attachment id so the next run knows to take the update path.
