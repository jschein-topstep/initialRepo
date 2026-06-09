export const SEVERITY = {
  FAIL: "fail",
  WARNING: "warning",
  INFO: "info",
  PASS: "pass"
};

export const NSOA_RULES = {
  "NSOA.context.getParameter": {
    description: "Reads a script parameter; result should be checked for empty/null or have alternate logic.",
    minArgs: 1,
    argRules: [{ index: 0, notEmpty: true }],
    requiresResultCheck: true,
    resultCheckSeverity: SEVERITY.FAIL
  },
  "NSOA.context.remainingTime": { description: "No checks needed.", noCheck: true },
  "NSOA.context.remainingUnits": { description: "No checks needed.", noCheck: true },

  "NSOA.form.confirmation": { minArgs: 1, argRules: [{ index: 0, notEmpty: true }] },
  "NSOA.form.error": { minArgs: 2, argRules: [{ index: 1, notEmpty: true }] },
  "NSOA.form.getAllValues": { noCheck: true },
  "NSOA.form.getLabel": { minArgs: 1, argRules: [{ index: 0, notEmpty: true }] },
  "NSOA.form.getName": { minArgs: 1, argRules: [{ index: 0, notEmpty: true }] },
  "NSOA.form.getNewRecord": { requiresResultCheck: true, resultCheckSeverity: SEVERITY.FAIL },
  "NSOA.form.getOldRecord": {
    requiresResultCheck: true,
    resultCheckSeverity: SEVERITY.FAIL,
    custom: "requiresTypeNotNewGuard"
  },
  "NSOA.form.getValue": { minArgs: 1, argRules: [{ index: 0, notEmpty: true }] },
  "NSOA.form.setValue": { minArgs: 2, argRules: [{ index: 0, notEmpty: true }] },
  "NSOA.form.warning": { minArgs: 1, argRules: [{ index: 0, notEmpty: true }] },

  "NSOA.https.delete": { minArgs: 1, requestObject: { required: ["url", "headers"], warnIfMissing: ["body"] }, requiresResultCheck: true },
  "NSOA.https.get": { minArgs: 1, requestObject: { required: ["url", "headers"] }, requiresResultCheck: true },
  "NSOA.https.patch": { minArgs: 1, requestObject: { required: ["url", "headers"], warnIfMissing: ["body"] }, requiresResultCheck: true },
  "NSOA.https.post": { minArgs: 1, requestObject: { required: ["url", "headers"], warnIfMissing: ["body"] }, requiresResultCheck: true },
  "NSOA.https.put": { minArgs: 1, requestObject: { required: ["url", "headers"], warnIfMissing: ["body"] }, requiresResultCheck: true },

  "NSOA.meta.alert": { minArgs: 1, argRules: [{ index: 0, notEmpty: true }] },
  "NSOA.meta.log": {
    minArgs: 2,
    argRules: [
      { index: 0, notEmpty: true, allowedValues: ["error", "warning", "info", "debug", "trace"] },
      { index: 1, notEmpty: true }
    ]
  },
  "NSOA.meta.sendMail": { minArgs: 1, requestObject: { required: ["to", "subject", "body"] }, requiresResultCheck: true },

  "NSOA.report.data": {
    minArgs: 1,
    argRules: [{ index: 0, notEmpty: true }],
    requiresResultCheck: true,
    resultCheckSeverity: SEVERITY.FAIL
  },

  "NSOA.wsapi.add": { minArgs: 1, arrayArgIndexes: [0], objectIdRule: "mustNotHaveId", requiresResultCheck: true, resultCheckSeverity: SEVERITY.FAIL },
  "NSOA.wsapi.approve": { minArgs: 1, arrayArgIndexes: [0], requiresResultCheck: true, approvalAction: "approve" },
  "NSOA.wsapi.delete": { minArgs: 1, arrayArgIndexes: [0], objectIdRule: "mustHaveId", requiresResultCheck: true, resultCheckSeverity: SEVERITY.FAIL },
  "NSOA.wsapi.disableFilterSet": { minArgs: 1, argRules: [{ index: 0, booleanLiteralPreferred: true }] },
  "NSOA.wsapi.modify": { minArgs: 2, arrayArgIndexes: [0, 1], objectIdRule: "mustHaveId", requiresResultCheck: true, resultCheckSeverity: SEVERITY.FAIL },
  "NSOA.wsapi.read": {
    minArgs: 1,
    requestObject: { required: ["type", "method", "fields", "objects", "attributes"], requiredNonEmpty: ["type", "method"] },
    requiresResultCheck: true,
    resultCheckSeverity: SEVERITY.FAIL
  },
  "NSOA.wsapi.reject": { minArgs: 1, arrayArgIndexes: [0], requiresResultCheck: true, approvalAction: "reject" },
  "NSOA.wsapi.submit": { minArgs: 1, arrayArgIndexes: [0], requiresResultCheck: true, approvalAction: "submit" },
  "NSOA.wsapi.unapprove": { minArgs: 1, arrayArgIndexes: [0], requiresResultCheck: true, approvalAction: "unapprove" },
  "NSOA.wsapi.upsert": { minArgs: 2, arrayArgIndexes: [0, 1], requiresResultCheck: true, resultCheckSeverity: SEVERITY.FAIL },
  "NSOA.wsapi.whoami": { noCheck: true }
};
