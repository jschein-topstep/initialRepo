import { chromium } from "playwright-extra";
import chromiumAws from "@sparticuz/chromium";
import stealth from "puppeteer-extra-plugin-stealth";
chromium.use(stealth());

// ---------------------------------------------------------------------------
// Shared company ID — all subsidiaries log into the same SPP company/instance,
// so this lives in one place instead of being repeated per subsidiary.
// ---------------------------------------------------------------------------
const OA_COMPANY_ID = process.env.OA_COMPANY_ID;

// ---------------------------------------------------------------------------
// Per-subsidiary configuration. Add a new subsidiary here and it's available
// to the handler immediately — no other code changes needed.
//
// Set env vars in Lambda like:
//   TRIVOCA_OA_USER_ID / TRIVOCA_OA_PASSWORD
//   IMPETUS_OA_USER_ID / IMPETUS_OA_PASSWORD
// ---------------------------------------------------------------------------
const SUBSIDIARIES = {
  trivoca: {
    label: "TriVoca",
    userId: process.env.TRIVOCA_OA_USER_ID,
    password: process.env.TRIVOCA_OA_PASSWORD,
  },
  impetus: {
    label: "Impetus",
    userId: process.env.IMPETUS_OA_USER_ID,
    password: process.env.IMPETUS_OA_PASSWORD,
  },
};

// AWS Lambda entry point.
// Invoked via a Lambda Function URL, so the SPP script's POST body arrives
// as a raw JSON string in event.body (not as top-level event properties) —
// same shape as API Gateway's payload format 2.0. We parse it here to get
// the subsidiary the caller asked for (e.g. {"subsidiary":"TriVoca"}).
// Falls back to DEFAULT_SUBSIDIARY env var, then "trivoca", so manual
// test invocations without a body still work.
export const handler = async (event = {}) => {
  let requestBody = {};
  if (event.body) {
    try {
      requestBody =
        typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch (err) {
      console.error("Could not parse request body as JSON:", event.body);
    }
  }

  const subsidiaryKey = (
    requestBody.subsidiary ||
    event.subsidiary || // still supported for direct/manual invocation in the Lambda console
    process.env.DEFAULT_SUBSIDIARY ||
    "trivoca"
  ).toLowerCase();

  const config = SUBSIDIARIES[subsidiaryKey];
  if (!config) {
    throw new Error(
      `Unknown subsidiary "${subsidiaryKey}". Valid options: ${Object.keys(SUBSIDIARIES).join(", ")}`,
    );
  }

  const creds = {
    companyId: OA_COMPANY_ID,
    userId: config.userId,
    password: config.password,
  };

  if (!creds.companyId || !creds.userId || !creds.password) {
    throw new Error(
      `Missing credentials for subsidiary "${subsidiaryKey}" — check OA_COMPANY_ID and the ${config.label.toUpperCase()}_OA_* env vars`,
    );
  }

  console.log(`Running invoice baseline for subsidiary: ${config.label}`);

  const browser = await chromium.launch({
    args: chromiumAws.args,
    executablePath: await chromiumAws.executablePath(),
    headless: true,
  });

  const baseUrl = process.env.BASE_URL;
  const page = await browser.newPage();

  // Open SuiteProjects login page --
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });

  // wait for the form to actually render, not just the HTML to parse
  await page.waitForSelector("input", { timeout: 20000 }).catch(() => {});

  const inputCount = await page.$$eval("input", (els) => els.length);
  console.log("INPUT COUNT after wait:", inputCount);

  const inputs = await page.$$eval("input", (els) =>
    els.map((e) => ({
      name: e.name,
      id: e.id,
      type: e.type,
      placeholder: e.placeholder,
    })),
  );
  console.log("INPUTS:", JSON.stringify(inputs));

  // also grab a chunk of HTML so we can see the structure if inputs is still empty
  const html = await page.content();
  //console.log("HTML SNIPPET:", html.slice(0, 2500));

  // Fill login form using this subsidiary's identity
  await page.fill('input[name="companyID"]', creds.companyId);
  await page.fill('input[name="userID"]', creds.userId);
  await page.fill('input[name="password"]', creds.password);

  // Submit login form and wait for redirect into SuiteProjects
  await Promise.all([
    page.waitForNavigation(),
    page.click('button[type="submit"], input[type="submit"]'),
  ]);

  // Give post-login redirects/scripts a moment to settle
  await page.waitForTimeout(3000);

  // After login, URL contains a temporary uid needed by internal endpoints
  const uid = extractUid(page.url());
  if (!uid) throw new Error(`Could not extract uid from URL: ${page.url()}`);

  console.log("uid: " + uid);
  // Ask SuiteProjects for the action menu for this project.
  // This is the key endpoint that returns generated URLs with valid r= tokens.
  const actionJson = await page.evaluate(
    async ({ uid, baseUrl }) => {
      const res = await fetch(
        `${baseUrl}/webapi/v2/navigation/action_menu/by_module/tb?uid=${uid}&app=pm`,
        {
          credentials: "include",
        },
      );
      const text = await res.text();
      try {
        return { ok: true, data: JSON.parse(text) };
      } catch {
        return { ok: false, status: res.status, body: text.slice(0, 2000) };
      }
    },
    { uid, baseUrl },
  );
  //console.log("action result:", JSON.stringify(actionJson).slice(0, 2000));

  // Find the "Invoices - All" action URL from the returned menu JSON
  const invoiceAllUrl = findUrlByPath(actionJson.data, [
    "invoices",
    "new_multiple_invoices",
  ]);

  if (!invoiceAllUrl) {
    throw new Error("Could not find invoice-all URL");
  }

  // Open the generated baseline creation form URL
  await page.goto(invoiceAllUrl, { waitUntil: "domcontentloaded" });
  await page
    .waitForLoadState("networkidle", { timeout: 15000 })
    .catch(() => {});

  // Fill out the create multiple invoices form
  await page.fill('input[name="invoice_date"]', `06/07/2026`);

  await page.fill('input[name="acct_date"]', "06/08/2026");
  await page.selectOption('select[name="date_range"]', "All");
  // Optional: mark it as reporting/comparison baseline
  // await page.check('input[name="comparison_baseline"]');

  // Submit the form
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
    page.click(
      'input[type="submit"][name="save"], input[type="submit"][value="Save"]',
    ),
  ]);

  await page.waitForLoadState("domcontentloaded").catch(() => {});

  // One more page: a confirmation/second step. Let it settle, then click its
  // submit button and wait for the resulting navigation.

  await page
    .waitForLoadState("networkidle", { timeout: 15000 })
    .catch(() => {});

  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
    page.click('input[type="submit"], button[type="submit"]'),
  ]);

  await page.waitForLoadState("domcontentloaded").catch(() => {});

  // Capture final page HTML for basic validation/debugging
  const resultHtml = await page.content();
  const bodyText = await page.evaluate(() => document.body.innerText);
  //console.log("BODY TEXT:", bodyText.slice(0, 3000));

  await browser.close();

  // Return a Function URL-shaped response so the SPP script's https.post
  // gets a predictable statusCode + JSON body to parse.
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      subsidiary: config.label,
      finalUrl: page.url(),
      snippet: resultHtml.substring(0, 2000),
    }),
  };
};

// Extract uid value from a SuiteProjects URL.
// Example: dashboard.pl?...;uid=abc123;r=xyz
function extractUid(url) {
  return url.match(/[?;]uid=([^;]+)/)?.[1];
}

// Recursively search a SuiteProjects menu JSON for an item matching a path of
// names, returning its URL. Each element of `path` must match a name as you
// descend; only the final name's URL is returned.
function findUrlByPath(list, path) {
  const items = Array.isArray(list) ? list : list?.data;
  if (!items || !path.length) return null;

  const [head, ...rest] = path;

  for (const item of items) {
    if (item.name === head) {
      if (rest.length === 0) {
        if (item.url) return item.url; // final segment: this is the target
      } else {
        const found = findUrlByPath(item.items, rest); // descend for the rest
        if (found) return found;
      }
    }

    // also allow `head` to appear deeper in the tree (preserves old any-depth behavior)
    const nested = findUrlByPath(item.items, path);
    if (nested) return nested;
  }

  return null;
}
