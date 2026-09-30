/**
 * ============================================================================
 *  SPP → Jira Integration  (SR-2707)
 * ============================================================================
 *  File:        spp_jira_sync.mjs
 *  Runtime:     AWS Lambda, Node.js 20.x (ESM)
 *  Trigger:     EventBridge schedule (TBD, e.g. every 15 min)
 *  Owner:       Kim Ward (business)
 *  MLG Sub:     Impetus
 *  Spec:        Confluence > "SPP>Jira Integration" (page 3849814017)
 *
 *  WHAT IT DOES
 *  ------------
 *  One-way sync of project structure from SuiteProjects Pro (SPP) to Jira Cloud.
 *
 *    1. Reads SPP projects updated since the last successful run (watermark
 *       stored in SSM Parameter Store).
 *    2. Splits them into PARENT and CHILD projects.
 *    3. PARENT project  → creates/updates a Jira project (space).
 *         - Project lead = SPP Project Manager
 *         - Customer name written to the Jira project description
 *    4. CHILD project   → creates/updates an Epic in its parent's Jira project.
 *         - Custom fields: Project Manager, Account Director, Budget,
 *           Customer, SPP Project ID
 *    5. Writes the created Jira project key / epic key back to an SPP custom
 *       field so later runs update instead of duplicating.
 *    6. Advances the watermark only if the run completed without fatal error.
 *
 *  OUT OF SCOPE (per spec)
 *  -----------------------
 *    - Jira → SPP data flow (TBD; possible status for revenue recognition)
 *    - Assigning Jira tasks from PM / AD values (expected to be Jira
 *      automation rules on the Jira side, not this script)
 *
 *  CONVENTIONS
 *  -----------
 *    // TODO(CLARIFY): needs a business / spec answer (Kim / client)
 *    // TODO(CONFIG):  needs an environment value, ID or field name
 *    // TODO(DEV):     technical decision or follow-up for the developer
 *    grep "TODO(" to see everything outstanding.
 *
 *  ENVIRONMENT VARIABLES
 *  ---------------------
 *    SPP_API_URL                 e.g. https://<company>.app.openair.com/api.pl
 *    SPP_SECRET_ARN              Secrets Manager JSON: {company,user,password,apiKey,apiNamespace,client}
 *    JIRA_BASE_URL               e.g. https://<site>.atlassian.net
 *    JIRA_SECRET_ARN             Secrets Manager JSON: {email,apiToken}
 *    JIRA_PROJECT_TYPE_KEY       default "software"
 *    JIRA_PROJECT_TEMPLATE_KEY   e.g. com.pyxis.greenhopper.jira:gh-simplified-scrum-classic
 *    JIRA_CF_PROJECT_MANAGER     e.g. customfield_10050  (user picker)
 *    JIRA_CF_ACCOUNT_DIRECTOR    e.g. customfield_10051  (user picker)
 *    JIRA_CF_BUDGET              e.g. customfield_10052  (number)
 *    JIRA_CF_CUSTOMER            e.g. customfield_10053  (text)   - optional
 *    JIRA_CF_SPP_ID              e.g. customfield_10054  (text)   - optional
 *    SPP_CF_PARENT_PROJECT       SPP custom field holding parent project id
 *    SPP_CF_ACCOUNT_DIRECTOR     SPP custom field holding AD user id
 *    SPP_CF_JIRA_KEY             SPP custom field to store Jira project/epic key
 *    WATERMARK_PARAM             SSM parameter name, e.g. /spp-jira/last-run
 *    INITIAL_LOOKBACK_HOURS      used when no watermark exists (default 24)
 *    DRY_RUN                     "true" = log intended actions, write nothing
 *
 *  DEPENDENCIES
 *  ------------
 *    fast-xml-parser  (Lambda layer or bundled)
 *    @aws-sdk/client-secrets-manager, @aws-sdk/client-ssm (included in runtime)
 * ============================================================================
 */

import { XMLParser } from "fast-xml-parser";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CFG = {
  sppApiUrl: process.env.SPP_API_URL,
  sppSecretArn: process.env.SPP_SECRET_ARN,
  jiraBaseUrl: process.env.JIRA_BASE_URL,
  jiraSecretArn: process.env.JIRA_SECRET_ARN,
  jiraProjectTypeKey: process.env.JIRA_PROJECT_TYPE_KEY || "software",
  // TODO(CLARIFY): Which Jira template / board type does the client want
  //   (scrum vs kanban, company-managed vs team-managed)? The REST create
  //   project endpoint only supports company-managed templates cleanly.
  jiraProjectTemplateKey: process.env.JIRA_PROJECT_TEMPLATE_KEY,
  // TODO(CLARIFY): Spec says "Custom Field – Name TBD" for PM and AD.
  // TODO(CONFIG):  Once named/created in Jira, put the customfield_xxxxx IDs here.
  cf: {
    projectManager: process.env.JIRA_CF_PROJECT_MANAGER,
    accountDirector: process.env.JIRA_CF_ACCOUNT_DIRECTOR,
    budget: process.env.JIRA_CF_BUDGET,
    customer: process.env.JIRA_CF_CUSTOMER,
    sppId: process.env.JIRA_CF_SPP_ID,
  },
  spp: {
    // TODO(CLARIFY): How is parent/child defined in SPP for this client?
    //   Assumed: a custom field on the child project holding the parent's
    //   project id. Could instead be a project group, a naming convention,
    //   or a project stage. The getParentId() function isolates this.
    parentProjectField:
      process.env.SPP_CF_PARENT_PROJECT || "parent_project__c",
    // TODO(CLARIFY): Where does "Account Director" live in SPP?
    //   Assumed: project-level user custom field. Could also be the
    //   customer's account owner (Customer.userid) - confirm.
    accountDirectorField:
      process.env.SPP_CF_ACCOUNT_DIRECTOR || "account_director__c",
    // TODO(CLARIFY): Spec is SPP → Jira only, but idempotency needs the Jira
    //   key stored somewhere. Writing it back to an SPP custom field is the
    //   simplest option. Confirm this write is acceptable (alternative:
    //   DynamoDB mapping table, or JQL lookup on the SPP ID field only).
    jiraKeyField: process.env.SPP_CF_JIRA_KEY || "jira_key__c",
  },
  watermarkParam: process.env.WATERMARK_PARAM || "/spp-jira/last-run",
  initialLookbackHours: Number(process.env.INITIAL_LOOKBACK_HOURS || 24),
  dryRun: String(process.env.DRY_RUN).toLowerCase() === "true",
  sppPageSize: 1000,
};

const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
});

// Cached across warm invocations
let sppCreds;
let jiraAuthHeader;
const jiraUserCache = new Map(); // email -> accountId | null
const sppUserCache = new Map(); // SPP user id -> { id, name, email }
const sppCustomerCache = new Map(); // SPP customer id -> { id, name }

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (event = {}) => {
  const runStartedAt = new Date();
  const results = { created: [], updated: [], skipped: [], errors: [] };

  await loadSecrets();

  // Allow manual re-runs: { "since": "2026-09-01T00:00:00Z" } or { "projectIds": ["123"] }
  const since = event.since ? new Date(event.since) : await getWatermark();
  console.log(`Run start. since=${since.toISOString()} dryRun=${CFG.dryRun}`);

  // TODO(CLARIFY): Data Needs section is empty. Do we need a one-time
  //   historical load of existing projects? If so, run once with an early
  //   "since" date. Also: which projects are in scope - active only?
  //   Specific project stages? Specific customers / Impetus subsidiary only?
  const projects = event.projectIds
    ? await sppReadProjectsByIds(event.projectIds)
    : await sppReadProjectsUpdatedSince(since);

  const inScope = projects.filter(isInScope);
  console.log(
    `Fetched ${projects.length} projects, ${inScope.length} in scope`,
  );

  const parents = inScope.filter((p) => !getParentId(p));
  const children = inScope.filter((p) => getParentId(p));

  // Parents first so children can resolve their Jira project key.
  const parentKeyById = new Map();
  for (const p of parents) {
    try {
      const key = await syncParentProject(p, results);
      if (key) parentKeyById.set(p.id, key);
    } catch (err) {
      logError(results, "parent", p, err);
    }
  }

  for (const c of children) {
    try {
      await syncChildProject(c, parentKeyById, results);
    } catch (err) {
      logError(results, "child", c, err);
    }
  }

  // Only advance watermark on a clean run so failures get retried.
  // TODO(DEV): Consider a per-record retry/dead-letter approach instead, so one
  //   bad record doesn't cause everything to re-process each run.
  if (
    !event.since &&
    !event.projectIds &&
    results.errors.length === 0 &&
    !CFG.dryRun
  ) {
    await setWatermark(runStartedAt);
  }

  const summary = {
    created: results.created.length,
    updated: results.updated.length,
    skipped: results.skipped.length,
    errors: results.errors.length,
  };
  console.log("Run summary", JSON.stringify(summary));
  if (results.errors.length)
    console.error("Errors", JSON.stringify(results.errors, null, 2));

  // TODO(CLARIFY): Who should be notified on errors (email/SNS/Slack/Jira ticket)?
  return { summary, ...results };
};

// ---------------------------------------------------------------------------
// Scope + hierarchy rules
// ---------------------------------------------------------------------------
function getParentId(project) {
  // TODO(CLARIFY): See CFG.spp.parentProjectField. Replace if hierarchy is
  //   defined differently in SPP.
  const v = project[CFG.spp.parentProjectField];
  return v && String(v).trim() !== "" && v !== "0" ? String(v).trim() : null;
}

function isInScope(project) {
  // TODO(CLARIFY): Filter rules. Current assumption: active projects only.
  // TODO(CLARIFY): What happens when a project goes inactive/closed in SPP?
  //   Options: do nothing, archive the Jira project, transition the Epic to
  //   Done. Currently inactive projects are simply skipped.
  return project.active === "1";
}

// ---------------------------------------------------------------------------
// Parent project → Jira project (space)
// ---------------------------------------------------------------------------
async function syncParentProject(p, results) {
  const customer = await sppGetCustomer(p.customerid);
  const pm = await sppGetUser(p.userid); // SPP project owner = Project Manager
  // TODO(CLARIFY): Confirm SPP "project owner" (Project.userid) is the Project
  //   Manager. Some setups use a custom field or the project's "PM" role.
  const pmAccountId = pm ? await jiraFindAccountIdByEmail(pm.email) : null;

  const existingKey = p[CFG.spp.jiraKeyField];
  const name = buildJiraProjectName(p, customer);
  const description = `SPP Project ID: ${p.id}\nCustomer: ${customer?.name ?? "n/a"}`;
  // TODO(CLARIFY): Spec says "Customer information is passed from SPP to Jira"
  //   but doesn't say where. Jira projects have no custom fields. Options:
  //   project description (done here), a Project Category per customer,
  //   a customer custom field on every Epic (also done below if configured),
  //   or a JSM Organization. Confirm which, and which customer fields
  //   besides name (number? address? contacts?).

  // TODO(CLARIFY): Account Director at the parent level. Jira projects only
  //   have a single "lead". AD is currently only set on child Epics.
  //   Is that sufficient, or does AD need to be on the project too
  //   (e.g. as a project role member or project property)?

  if (existingKey) {
    // TODO(CLARIFY): Which fields should update after creation? Currently:
    //   name, lead, description. Renaming a Jira project is allowed but
    //   the key never changes.
    await jiraRequest(
      "PUT",
      `/rest/api/3/project/${encodeURIComponent(existingKey)}`,
      {
        name,
        description,
        ...(pmAccountId && { leadAccountId: pmAccountId }),
      },
    );
    results.updated.push({
      type: "project",
      sppId: p.id,
      jiraKey: existingKey,
    });
    return existingKey;
  }

  if (!pmAccountId) {
    // Jira requires a project lead on create.
    // TODO(CLARIFY): Fallback lead when PM is missing or not a Jira user?
    //   Currently skipped and reported as an error.
    throw new Error(
      `No Jira user found for PM (SPP user ${p.userid}, email ${pm?.email ?? "n/a"})`,
    );
  }

  const key = await generateUniqueProjectKey(p, customer);
  const created = await jiraRequest("POST", "/rest/api/3/project", {
    key,
    name,
    description,
    projectTypeKey: CFG.jiraProjectTypeKey,
    projectTemplateKey: CFG.jiraProjectTemplateKey,
    leadAccountId: pmAccountId,
    assigneeType: "UNASSIGNED",
    // TODO(CLARIFY): Permission scheme / notification scheme / issue type
    //   scheme to apply? Affects whether Epics and the custom fields are
    //   available in new projects.
    // TODO(CONFIG): If a shared configuration project exists, consider
    //   creating via "shared configuration" instead of a template.
  });

  const newKey = created?.key ?? key;
  await sppWriteJiraKey(p.id, newKey);
  results.created.push({ type: "project", sppId: p.id, jiraKey: newKey });
  return newKey;
}

function buildJiraProjectName(p, customer) {
  // TODO(CLARIFY): Naming convention for Jira projects. Assumed
  //   "<Customer> - <Project name>". Jira project names max 80 chars.
  const base = customer?.name ? `${customer.name} - ${p.name}` : p.name;
  return base.slice(0, 80);
}

async function generateUniqueProjectKey(p, customer) {
  // TODO(CLARIFY): How should Jira project keys be formed? (Uppercase,
  //   starts with a letter, 2–10 chars, unique site-wide.) Assumed: derived
  //   from customer + project initials, with a numeric suffix if taken.
  //   Alternative: an SPP field that holds the desired key.
  const source = `${customer?.name ?? ""} ${p.name}`;
  let base = source
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  if (!/^[A-Z]/.test(base)) base = `P${base}`;
  base = base.slice(0, 7).padEnd(2, "X");

  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}${i}`.slice(0, 10);
    const exists = await jiraRequest(
      "GET",
      `/rest/api/3/project/${candidate}`,
      null,
      { allow404: true },
    );
    if (!exists) return candidate;
  }
  throw new Error(`Could not generate unique Jira key for SPP project ${p.id}`);
}

// ---------------------------------------------------------------------------
// Child project → Jira Epic
// ---------------------------------------------------------------------------
async function syncChildProject(c, parentKeyById, results) {
  const parentId = getParentId(c);
  let jiraProjectKey = parentKeyById.get(parentId);

  if (!jiraProjectKey) {
    // Parent wasn't updated in this window; look it up in SPP.
    const [parent] = await sppReadProjectsByIds([parentId]);
    jiraProjectKey = parent?.[CFG.spp.jiraKeyField];
    if (!jiraProjectKey) {
      // TODO(CLARIFY): If a child exists before its parent is synced (or the
      //   parent is out of scope), should we create the parent on the fly,
      //   or wait? Currently skipped; it will retry on the next update.
      results.skipped.push({
        type: "epic",
        sppId: c.id,
        reason: `Parent ${parentId} has no Jira project yet`,
      });
      return;
    }
  }

  const customer = await sppGetCustomer(c.customerid);
  const pm = await sppGetUser(c.userid);
  const ad = await sppGetUser(c[CFG.spp.accountDirectorField]);
  const pmAccountId = pm ? await jiraFindAccountIdByEmail(pm.email) : null;
  const adAccountId = ad ? await jiraFindAccountIdByEmail(ad.email) : null;

  // TODO(CLARIFY): Which SPP value is "Child Budget Amount"? Assumed the
  //   standard Project.budget field. Could be budget hours, a project budget
  //   (Projectbudgetgroup / Projectbudgettransaction) total, or a custom
  //   field. Also: currency - is everything one currency?
  const budget =
    c.budget !== undefined && c.budget !== "" ? Number(c.budget) : null;

  const fields = {
    summary: c.name.slice(0, 255),
    description: adfText(
      `SPP Project ID: ${c.id}\nCustomer: ${customer?.name ?? "n/a"}`,
    ),
  };
  // TODO(CONFIG): These only work once the custom fields exist AND are on the
  //   Epic create/edit screens for the target projects.
  if (CFG.cf.projectManager)
    fields[CFG.cf.projectManager] = pmAccountId
      ? { accountId: pmAccountId }
      : null;
  if (CFG.cf.accountDirector)
    fields[CFG.cf.accountDirector] = adAccountId
      ? { accountId: adAccountId }
      : null;
  if (CFG.cf.budget)
    fields[CFG.cf.budget] = Number.isFinite(budget) ? budget : null;
  if (CFG.cf.customer) fields[CFG.cf.customer] = customer?.name ?? null;
  if (CFG.cf.sppId) fields[CFG.cf.sppId] = String(c.id);

  // TODO(CLARIFY): Should the Epic assignee be the PM? Spec says PM/AD are
  //   used "for assignment to tasks" - assumed that's Jira automation on
  //   child issues, not something this script does.

  const existingKey =
    c[CFG.spp.jiraKeyField] ||
    (await jiraFindEpicBySppId(jiraProjectKey, c.id));

  if (existingKey) {
    // TODO(CLARIFY): If a child project is moved to a different parent in
    //   SPP, should the Epic move projects? Not handled - Jira issue moves
    //   across projects aren't supported by the REST edit endpoint.
    await jiraRequest(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(existingKey)}`,
      { fields },
    );
    if (!c[CFG.spp.jiraKeyField]) await sppWriteJiraKey(c.id, existingKey);
    results.updated.push({ type: "epic", sppId: c.id, jiraKey: existingKey });
    return;
  }

  const created = await jiraRequest("POST", "/rest/api/3/issue", {
    fields: {
      project: { key: jiraProjectKey },
      // TODO(CONFIG): Issue type name/id may differ (e.g. localized, or team-managed
      //   projects). Could resolve via /rest/api/3/issue/createmeta.
      issuetype: { name: "Epic" },
      ...fields,
    },
  });

  const epicKey = created?.key ?? "(dry-run)";
  await sppWriteJiraKey(c.id, epicKey);
  results.created.push({ type: "epic", sppId: c.id, jiraKey: epicKey });
}

async function jiraFindEpicBySppId(projectKey, sppId) {
  // Safety net in case the SPP write-back failed on a previous run.
  if (!CFG.cf.sppId) return null;
  const cfNum = CFG.cf.sppId.replace("customfield_", "");
  const jql = `project = "${projectKey}" AND issuetype = Epic AND cf[${cfNum}] ~ "${sppId}"`;
  const res = await jiraRequest(
    "GET",
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=2`,
    null,
    {
      readOnly: true,
    },
  );
  const issues = res?.issues ?? [];
  if (issues.length > 1)
    console.warn(
      `Multiple Epics found for SPP ${sppId}; using ${issues[0].key}`,
    );
  return issues[0]?.key ?? null;
}

// ---------------------------------------------------------------------------
// SPP XML API
// ---------------------------------------------------------------------------
const PROJECT_RETURN_FIELDS = [
  "id",
  "name",
  "customerid",
  "userid",
  "budget",
  "currency",
  "active",
  "updated",
];

async function sppReadProjectsUpdatedSince(since) {
  // TODO(DEV): SPP stores "updated" in company timezone, not UTC. Confirm the
  //   company TZ and convert, or subtract a safety buffer (done: 10 min).
  const d = new Date(since.getTime() - 10 * 60 * 1000);
  const dateXml =
    `<Date><year>${d.getUTCFullYear()}</year><month>${pad(d.getUTCMonth() + 1)}</month><day>${pad(d.getUTCDate())}</day>` +
    `<hour>${pad(d.getUTCHours())}</hour><minute>${pad(d.getUTCMinutes())}</minute><second>${pad(d.getUTCSeconds())}</second></Date>`;

  return sppReadAllPages(
    (offset) =>
      `<Read type="Project" method="all" filter="newer-than" field="updated" limit="${offset},${CFG.sppPageSize}" enable_custom="1">` +
      `${dateXml}${returnXml()}</Read>`,
    "Project",
  );
}

async function sppReadProjectsByIds(ids) {
  const out = [];
  for (const id of ids) {
    const xml =
      `<Read type="Project" method="equal to" limit="1" enable_custom="1">` +
      `<Project><id>${esc(id)}</id></Project>${returnXml()}</Read>`;
    const res = await sppRequest(xml);
    out.push(...toArray(res.Read?.Project).map(normalize));
  }
  return out;
}

function returnXml() {
  const fields = [
    ...PROJECT_RETURN_FIELDS,
    CFG.spp.parentProjectField,
    CFG.spp.accountDirectorField,
    CFG.spp.jiraKeyField,
  ];
  return `<_Return>${fields.map((f) => `<${f}/>`).join("")}</_Return>`;
}

async function sppReadAllPages(buildReadXml, type) {
  const all = [];
  for (let offset = 0; ; offset += CFG.sppPageSize) {
    const res = await sppRequest(buildReadXml(offset));
    const rows = toArray(res.Read?.[type]).map(normalize);
    all.push(...rows);
    if (rows.length < CFG.sppPageSize) break;
  }
  return all;
}

async function sppGetCustomer(id) {
  if (!id || id === "0") return null;
  if (sppCustomerCache.has(id)) return sppCustomerCache.get(id);
  // TODO(CLARIFY): Which customer fields does Jira need beyond name?
  const xml =
    `<Read type="Customer" method="equal to" limit="1">` +
    `<Customer><id>${esc(id)}</id></Customer><_Return><id/><name/><company/></_Return></Read>`;
  const res = await sppRequest(xml);
  const c = toArray(res.Read?.Customer)[0];
  const val = c ? { id: c.id, name: c.name || c.company } : null;
  sppCustomerCache.set(id, val);
  return val;
}

async function sppGetUser(id) {
  if (!id || id === "0") return null;
  if (sppUserCache.has(id)) return sppUserCache.get(id);
  const xml =
    `<Read type="User" method="equal to" limit="1">` +
    `<User><id>${esc(id)}</id></User><_Return><id/><name/><addr/></_Return></Read>`;
  const res = await sppRequest(xml);
  const u = toArray(res.Read?.User)[0];
  // Email lives in the nested Address object on the User record.
  const email = u?.addr?.Address?.email ?? null;
  const val = u ? { id: u.id, name: u.name, email } : null;
  sppUserCache.set(id, val);
  return val;
}

async function sppWriteJiraKey(projectId, jiraKey) {
  if (CFG.dryRun) {
    console.log(
      `[DRY RUN] SPP Project ${projectId}.${CFG.spp.jiraKeyField} = ${jiraKey}`,
    );
    return;
  }
  const xml =
    `<Modify type="Project" enable_custom="1"><Project><id>${esc(projectId)}</id>` +
    `<${CFG.spp.jiraKeyField}>${esc(jiraKey)}</${CFG.spp.jiraKeyField}></Project></Modify>`;
  const res = await sppRequest(xml);
  assertSppStatus(res.Modify, "Modify Project");
}

async function sppRequest(innerXml) {
  const body =
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>` +
    `<request API_version="1.0" client="${esc(sppCreds.client || "spp-jira-sync")}" client_ver="1.0" ` +
    `namespace="${esc(sppCreds.apiNamespace || "default")}" key="${esc(sppCreds.apiKey)}">` +
    `<Auth><Login><company>${esc(sppCreds.company)}</company><user>${esc(sppCreds.user)}</user>` +
    `<password>${esc(sppCreds.password)}</password></Login></Auth>` +
    `${innerXml}</request>`;
  // TODO(DEV): If this client uses OAuth 2.0 for SPP, swap the Login block for
  //   the access_token auth and fetch the token first.

  const resp = await fetch(CFG.sppApiUrl, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body,
  });
  const text = await resp.text();
  if (!resp.ok)
    throw new Error(`SPP HTTP ${resp.status}: ${text.slice(0, 500)}`);

  const parsed = xmlParser.parse(text)?.response;
  if (!parsed)
    throw new Error(`SPP: unexpected response ${text.slice(0, 500)}`);
  assertSppStatus(parsed.Auth, "Auth");
  if (parsed.Read) assertSppStatus(parsed.Read, "Read", ["601"]); // 601 = no records
  return parsed;
}

function assertSppStatus(node, label, okCodes = []) {
  const status = String(toArray(node)[0]?.["@_status"] ?? "0");
  if (status !== "0" && !okCodes.includes(status))
    throw new Error(`SPP ${label} failed, status ${status}`);
}

// ---------------------------------------------------------------------------
// Jira REST API
// ---------------------------------------------------------------------------
async function jiraFindAccountIdByEmail(email) {
  if (!email) return null;
  const key = email.toLowerCase();
  if (jiraUserCache.has(key)) return jiraUserCache.get(key);
  // TODO(DEV): If Jira user profiles hide email (privacy settings), this
  //   search may not match. Fallback options: a mapping table (SPP user id →
  //   Jira accountId) in SSM/DynamoDB, or search by display name.
  const users = await jiraRequest(
    "GET",
    `/rest/api/3/user/search?query=${encodeURIComponent(email)}`,
    null,
    { readOnly: true },
  );
  const match =
    (users || []).find(
      (u) =>
        u.accountType === "atlassian" && u.emailAddress?.toLowerCase() === key,
    ) ?? (users?.length === 1 ? users[0] : null);
  const id = match?.accountId ?? null;
  if (!id) console.warn(`No Jira user for ${email}`);
  jiraUserCache.set(key, id);
  return id;
}

async function jiraRequest(
  method,
  path,
  body,
  { allow404 = false, readOnly = false } = {},
) {
  const isWrite = method !== "GET" && !readOnly;
  if (CFG.dryRun && isWrite) {
    console.log(
      `[DRY RUN] Jira ${method} ${path}`,
      body ? JSON.stringify(body) : "",
    );
    return null;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const resp = await fetch(`${CFG.jiraBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: jiraAuthHeader,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 404 && allow404) return null;
    if (resp.status === 429 || resp.status >= 500) {
      const wait =
        Number(resp.headers.get("Retry-After")) * 1000 || 1000 * 2 ** attempt;
      console.warn(
        `Jira ${resp.status} on ${method} ${path}, retry in ${wait}ms`,
      );
      await sleep(wait);
      continue;
    }
    const text = await resp.text();
    if (!resp.ok)
      throw new Error(
        `Jira ${method} ${path} → ${resp.status}: ${text.slice(0, 800)}`,
      );
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Jira ${method} ${path} failed after retries`);
}

function adfText(text) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .map((line) => ({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      })),
  };
}

// ---------------------------------------------------------------------------
// AWS helpers
// ---------------------------------------------------------------------------
async function loadSecrets() {
  if (sppCreds && jiraAuthHeader) return;
  const [spp, jira] = await Promise.all([
    getSecretJson(CFG.sppSecretArn),
    getSecretJson(CFG.jiraSecretArn),
  ]);
  sppCreds = spp;
  // TODO(CONFIG): Jira service account + API token. Needs "Administer Jira"
  //   (global) to create projects, plus browse/create/edit in the new projects.
  jiraAuthHeader = `Basic ${Buffer.from(`${jira.email}:${jira.apiToken}`).toString("base64")}`;
}

async function getSecretJson(arn) {
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  return JSON.parse(res.SecretString);
}

async function getWatermark() {
  try {
    const res = await ssm.send(
      new GetParameterCommand({ Name: CFG.watermarkParam }),
    );
    return new Date(res.Parameter.Value);
  } catch (err) {
    if (err.name !== "ParameterNotFound") throw err;
    return new Date(Date.now() - CFG.initialLookbackHours * 3600 * 1000);
  }
}

async function setWatermark(date) {
  await ssm.send(
    new PutParameterCommand({
      Name: CFG.watermarkParam,
      Value: date.toISOString(),
      Type: "String",
      Overwrite: true,
    }),
  );
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function toArray(v) {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function normalize(obj) {
  // fast-xml-parser returns '' for empty tags; keep strings for consistency.
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === "" ? "" : v;
  return out;
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function logError(results, kind, p, err) {
  console.error(`Failed ${kind} SPP ${p?.id}: ${err.message}`);
  results.errors.push({
    type: kind,
    sppId: p?.id,
    name: p?.name,
    error: err.message,
  });
}
