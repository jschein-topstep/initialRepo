import { NSOA_RULES, SEVERITY } from "./rules.mjs";

const RESULT_CHECK_RE = /(if\s*\(|throw\s+|return\s+|\.errors\b|\.length\b|==\s*null|===\s*null|!=\s*null|!==\s*null|!\s*[A-Za-z_$][\w$]*|NSOA\.meta\.log\s*\(|NSOA\.form\.error\s*\()/;
const TEST_CODE_RE = /\b(console\.log|debugger;|TODO\b|FIXME\b|testOnly|dummy|sample|hardcoded test|alert\s*\()/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const CUSTOM_FIELD_RE = /\b(cust[a-z0-9_]+__c|cust[a-z0-9_]+|u_[a-z0-9_]+)\b/ig;
const HARDCODED_ID_RE = /(['"])(\d{3,})\1/g;
const LASTRUN_RE = /\b(lastrun|lastRun|last_run|getLastDateRun|setLastDateRun)\b/;
const DIACRITICS_RE = /\b(diacritic|diacritics|removeDiacritics|normalize\(['"]NFD['"]\)|replace\(\/\[\\u0300-\\u036f\]\+\/g)/i;

export async function handler(event = {}) {
  const payload = parseEvent(event);
  const code = payload.code || payload.body?.code;

  if (!code || typeof code !== "string") {
    return response(400, { error: "Missing required string field: code" });
  }

  const options = {
    scriptType: payload.scriptType || "unknown",
    environment: payload.environment || "unknown",
    integrationScript: Boolean(payload.integrationScript),
    requireDiacritics: Boolean(payload.requireDiacritics)
  };

  const review = reviewCode(code, options);
  return response(200, review);
}

export function reviewCode(code, options = {}) {
  const lines = code.split(/\r?\n/);
  const stripped = stripCommentsPreserveLines(code);
  const calls = findNsoaCalls(stripped);
  const variableObjects = findObjectAssignments(stripped);
  const variableArrays = findArrayAssignments(stripped);
  const findings = [];

  runNsoaChecks({ calls, lines, stripped, variableObjects, variableArrays, findings });
  runChecklistChecks({ code, stripped, lines, calls, options, findings });

  const customFieldsFound = unique(matches(code, CUSTOM_FIELD_RE));
  const hardcodedEmails = unique(matches(code, EMAIL_RE));
  const hardcodedIds = unique([...code.matchAll(HARDCODED_ID_RE)].map(m => m[2]));

  if (hardcodedEmails.length) {
    addFinding(findings, "hardcoded-emails", "Hardcoded email addresses", SEVERITY.WARNING, [], `Found ${hardcodedEmails.length} hardcoded email address(es). Parameterize where reasonable.`, { values: hardcodedEmails });
  }
  if (hardcodedIds.length) {
    addFinding(findings, "hardcoded-ids", "Hardcoded numeric IDs", SEVERITY.WARNING, [], `Found ${hardcodedIds.length} hardcoded numeric ID(s). Parameterize where reasonable.`, { values: hardcodedIds.slice(0, 50) });
  }

  const summary = summarize(findings);
  return {
    summary,
    options,
    findings,
    customFieldsFound,
    hardcodedValues: { emails: hardcodedEmails, ids: hardcodedIds },
    callsFound: calls.map(c => ({ method: c.method, line: c.line, assignedTo: c.assignedTo || null }))
  };
}

function runNsoaChecks(ctx) {
  for (const call of ctx.calls) {
    const rule = NSOA_RULES[call.method] || inferRecordConstructorRule(call);
    if (!rule || rule.noCheck) continue;

    if (rule.minArgs != null && call.args.length < rule.minArgs) {
      addFinding(ctx.findings, "missing-args", `${call.method} arguments`, SEVERITY.FAIL, [call.line], `Expected at least ${rule.minArgs} argument(s), found ${call.args.length}.`);
    }

    checkArgRules(call, rule, ctx.findings);
    checkRequestObject(call, rule, ctx.variableObjects, ctx.findings);
    checkArrayArgs(call, rule, ctx.variableArrays, ctx.findings);
    checkApprovalAction(call, rule, ctx.findings);
    checkRecordConstructor(call, rule, ctx.findings);

    if (rule.requiresResultCheck) {
      checkResultHandling(call, ctx.lines, ctx.findings, rule.resultCheckSeverity || SEVERITY.WARNING);
    }

    if (rule.custom === "requiresTypeNotNewGuard") {
      checkTypeNotNewGuard(call, ctx.lines, ctx.findings);
    }
  }
}

function runChecklistChecks({ code, stripped, lines, options, findings }) {
  const headerChunk = lines.slice(0, 25).join("\n");
  const hasHeader = /description|developer|author|date/i.test(headerChunk);
  if (!hasHeader) addFinding(findings, "script-header", "Script header", SEVERITY.WARNING, [1], "Could not confirm header with description/date/developer near top of script.");

  const functionLines = findFunctionLines(stripped);
  for (const fn of functionLines) {
    if (/\b(main|run|execute)\b/i.test(fn.name)) continue;
    const prior = lines.slice(Math.max(0, fn.line - 5), fn.line - 1).join("\n");
    if (!/\/\*\*|\/\*|\/\//.test(prior) || !/description|desc|purpose/i.test(prior)) {
      addFinding(findings, "function-header", "Function header", SEVERITY.WARNING, [fn.line], `Could not confirm description header for function ${fn.name}.`);
    }
  }

  lines.forEach((line, idx) => {
    if (TEST_CODE_RE.test(line)) {
      addFinding(findings, "possible-test-code", "Possible test/debug code", SEVERITY.WARNING, [idx + 1], "Possible test/debug code remains.", { line: line.trim() });
    }
  });

  if (LASTRUN_RE.test(code) && !/NSOA\.meta\.(log|alert)\s*\([^)]*(lastrun|lastRun|last_run|getLastDateRun)/is.test(code)) {
    addFinding(findings, "lastrun-logging", "Last run logging", SEVERITY.WARNING, [], "Last-run logic appears to be used, but logging of the value was not confirmed.");
  }

  if ((options.integrationScript || options.requireDiacritics) && !DIACRITICS_RE.test(code)) {
    addFinding(findings, "diacritics", "Diacritics handling", SEVERITY.WARNING, [], "Integration script flagged, but no obvious diacritics normalization/library usage was found.");
  }

  if (/NSOA\.wsapi\.(read|modify|add|delete|upsert)\s*\(/.test(code) && !/>\s*1000|remainingUnits|remainingTime|while\s*\(|offset|limit|pagination|page/i.test(code)) {
    addFinding(findings, "scalability", "Scalability / >1000 handling", SEVERITY.INFO, [], "Could not confirm pagination, >1000 handling, or resource-limit logic.");
  }

  if (/NSOA\.wsapi\.(modify|add|delete|upsert)\s*\(/.test(code) && !/try\s*\{/.test(code)) {
    addFinding(findings, "try-catch", "Try/catch", SEVERITY.WARNING, [], "Modify/add/delete/upsert calls found but no try/catch block was detected.");
  }
}

function checkArgRules(call, rule, findings) {
  for (const ar of rule.argRules || []) {
    const arg = call.args[ar.index];
    if (arg == null) continue;
    if (ar.notEmpty && isClearlyEmpty(arg)) {
      addFinding(findings, "empty-arg", `${call.method} argument`, SEVERITY.FAIL, [call.line], `Argument ${ar.index + 1} appears empty/null.`);
    }
    if (ar.allowedValues) {
      const literal = stringLiteralValue(arg);
      if (literal && !ar.allowedValues.includes(literal)) {
        addFinding(findings, "invalid-value", `${call.method} argument`, SEVERITY.FAIL, [call.line], `Argument ${ar.index + 1} value "${literal}" is not allowed.`, { allowedValues: ar.allowedValues });
      } else if (!literal) {
        addFinding(findings, "dynamic-value", `${call.method} argument`, SEVERITY.INFO, [call.line], `Argument ${ar.index + 1} is dynamic; allowed values could not be confirmed.`, { allowedValues: ar.allowedValues });
      }
    }
    if (ar.booleanLiteralPreferred && !/^(true|false)$/i.test(arg.trim())) {
      addFinding(findings, "dynamic-boolean", `${call.method} argument`, SEVERITY.WARNING, [call.line], `Argument ${ar.index + 1} should resolve to true or false; static checker could not confirm.`);
    }
  }
}

function checkRequestObject(call, rule, variableObjects, findings) {
  if (!rule.requestObject) return;
  const arg = call.args[0]?.trim();
  const props = getObjectProps(arg, variableObjects);
  if (!props) {
    addFinding(findings, "request-object-unresolved", `${call.method} request object`, SEVERITY.WARNING, [call.line], "Could not statically inspect request object. Confirm required fields manually.", { required: rule.requestObject.required });
    return;
  }
  for (const prop of rule.requestObject.required || []) {
    if (!(prop in props)) addFinding(findings, "missing-request-field", `${call.method} request object`, SEVERITY.FAIL, [call.line], `Missing required request field: ${prop}.`);
  }
  for (const prop of rule.requestObject.requiredNonEmpty || []) {
    if (prop in props && isClearlyEmpty(props[prop])) addFinding(findings, "empty-request-field", `${call.method} request object`, SEVERITY.FAIL, [call.line], `Required request field appears empty: ${prop}.`);
  }
  for (const prop of rule.requestObject.warnIfMissing || []) {
    if (!(prop in props)) addFinding(findings, "missing-optional-body", `${call.method} request object`, SEVERITY.WARNING, [call.line], `No ${prop} field found; confirm this is intentional.`);
  }
}

function checkArrayArgs(call, rule, variableArrays, findings) {
  for (const idx of rule.arrayArgIndexes || []) {
    const arg = call.args[idx]?.trim();
    if (!arg) continue;
    if (arg.startsWith("[") || variableArrays.has(arg)) continue;
    addFinding(findings, "array-arg-unconfirmed", `${call.method} array argument`, SEVERITY.WARNING, [call.line], `Argument ${idx + 1} should be an array; static checker could not confirm.`);
  }
}

function checkApprovalAction(call, rule, findings) {
  if (!rule.approvalAction) return;
  const arg = call.args[0] || "";
  if (!arg.includes(rule.approvalAction) || !arg.includes("approval")) {
    addFinding(findings, "approval-shape-unconfirmed", `${call.method} request shape`, SEVERITY.WARNING, [call.line], `Could not confirm request items contain ${rule.approvalAction} and approval attributes.`);
  }
}

function checkRecordConstructor(call, rule, findings) {
  if (!rule.recordConstructor) return;
  const arg = call.args[0]?.trim();
  if (arg && !/^\d+$/.test(arg) && !/^[A-Za-z_$][\w$]*$/.test(arg)) {
    addFinding(findings, "record-id-numeric", "NSOA record constructor", SEVERITY.WARNING, [call.line], "Constructor parameter should be numeric or a variable known to contain a numeric ID.");
  }
}

function checkResultHandling(call, lines, findings, severity) {
  const windowText = lines.slice(call.line - 1, Math.min(lines.length, call.line + 8)).join("\n");
  if (call.assignedTo) {
    const re = new RegExp(`(if\\s*\\([^)]*\\b${escapeRegExp(call.assignedTo)}\\b|\\b${escapeRegExp(call.assignedTo)}\\b[^\\n]*(errors|length|==|!=|===|!==)|throw\\s+)`, "i");
    if (re.test(windowText)) return;
  }
  if (RESULT_CHECK_RE.test(windowText) && call.assignedTo) return;
  addFinding(findings, "result-check", `${call.method} result handling`, severity, [call.line], "Could not confirm result/null/error check shortly after this call.");
}

function checkTypeNotNewGuard(call, lines, findings) {
  const prior = lines.slice(Math.max(0, call.line - 10), call.line).join("\n");
  if (!/type\s*!={1,2}\s*['"]new['"]|['"]new['"]\s*!={1,2}\s*type/i.test(prior)) {
    addFinding(findings, "old-record-new-guard", "getOldRecord new-record guard", SEVERITY.FAIL, [call.line], "NSOA.form.getOldRecord used without nearby type != 'new' guard.");
  }
}

function inferRecordConstructorRule(call) {
  if (/^NSOA\.record\.[A-Za-z_$][\w$]*$/.test(call.method)) return { recordConstructor: true };
  return null;
}

function parseEvent(event) {
  if (typeof event === "string") return JSON.parse(event);
  if (event.body && typeof event.body === "string") {
    try { return { ...event, body: JSON.parse(event.body), ...JSON.parse(event.body) }; } catch { return event; }
  }
  return event;
}

function response(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body, null, 2) };
}

function stripCommentsPreserveLines(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

function findNsoaCalls(code) {
  const calls = [];
  const re = /(?:(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*|([A-Za-z_$][\w$]*)\s*=\s*)?(?:new\s+)?(NSOA\.(?:context|form|https|meta|record|report|wsapi)(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const start = re.lastIndex - 1;
    const end = findMatchingParen(code, start);
    if (end < 0) continue;
    const argString = code.slice(start + 1, end);
    calls.push({ method: m[3], args: splitArgs(argString), line: lineNumberAt(code, m.index), assignedTo: m[1] || m[2] || null });
    re.lastIndex = end + 1;
  }
  return calls;
}

function findObjectAssignments(code) {
  const map = new Map();
  const re = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf("{", m.index);
    const close = findMatchingBrace(code, open);
    if (close > open) {
      map.set(m[1], parseObjectProps(code.slice(open, close + 1)));
      re.lastIndex = close + 1;
    }
  }
  return map;
}

function findArrayAssignments(code) {
  const set = new Set();
  const re = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  let m;
  while ((m = re.exec(code)) !== null) set.add(m[1]);
  return set;
}

function getObjectProps(arg, variableObjects) {
  if (!arg) return null;
  if (arg.startsWith("{")) return parseObjectProps(arg);
  return variableObjects.get(arg) || null;
}

function parseObjectProps(objText) {
  const inner = objText.trim().replace(/^\{/, "").replace(/\}$/, "");
  const props = {};
  for (const part of splitArgs(inner)) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, "");
    props[key] = part.slice(colon + 1).trim();
  }
  return props;
}

function splitArgs(s) {
  const out = [];
  let cur = "", depth = 0, quote = null, esc = false;
  for (const ch of s) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === "\\") { cur += ch; esc = true; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function findMatchingParen(s, open) { return findMatching(s, open, "(", ")"); }
function findMatchingBrace(s, open) { return findMatching(s, open, "{", "}"); }
function findMatching(s, open, a, b) {
  let depth = 0, quote = null, esc = false;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === a) depth++;
    if (ch === b) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findFunctionLines(code) {
  const out = [];
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push({ name: m[1] || m[2], line: lineNumberAt(code, m.index) });
  return out;
}

function lineNumberAt(s, idx) { return s.slice(0, idx).split("\n").length; }
function isClearlyEmpty(arg) { return /^(null|undefined|['"]\s*['"])$/i.test(arg.trim()); }
function stringLiteralValue(arg) { const m = arg.trim().match(/^['"]([^'"]*)['"]$/); return m ? m[1] : null; }
function matches(s, re) { return [...s.matchAll(re)].map(m => m[0]); }
function unique(a) { return [...new Set(a)]; }
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function addFinding(findings, id, name, status, lines, message, extra = {}) {
  findings.push({ id, name, status, lines, message, ...extra });
}

function summarize(findings) {
  const summary = { pass: 0, info: 0, warning: 0, fail: 0 };
  for (const f of findings) summary[f.status] = (summary[f.status] || 0) + 1;
  return summary;
}
