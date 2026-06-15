import { chromium } from "playwright-core";
import chromiumAws from "@sparticuz/chromium";

// AWS Lambda entry point
export const handler = async () => {
  // TODO: Replace this hardcoded ID with event.projectId later
  //const projectId = "2595";

  // Start headless Chromium using the Lambda-compatible Chromium binary
  const browser = await chromium.launch({
    args: chromiumAws.args,
    executablePath: await chromiumAws.executablePath(),
    headless: true,
  });

  const page = await browser.newPage();

  // Open SuiteProjects login page
  await page.goto(
    "https://mlg-sb.app.sandbox.netsuitesuiteprojectspro.com/login",
    {
      waitUntil: "networkidle",
    },
  );

  // Fill login form from Lambda environment variables
  await page.fill('input[name="companyID"]', process.env.OA_COMPANY_ID);
  await page.fill('input[name="userID"]', process.env.OA_USER_ID);
  await page.fill('input[name="password"]', process.env.OA_PASSWORD);

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
  const actionResp = await page.request.get(
    `https://mlg-sb.app.sandbox.netsuitesuiteprojectspro.com/webapi/v2/navigation/action_menu/by_module/tb?uid=${uid}&app=pm`,
  );

  console.log("actionResp: " + actionResp.text());
  const actionJson = JSON.parse(await actionResp.text());

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

  // Fill out the baseline form
  await page.fill('input[name="invoice_date"]', `06/07/2026`);

  await page.fill('input[name="acct_date"]', "06/08/2026");

  // Optional: mark it as reporting/comparison baseline
  // await page.check('input[name="comparison_baseline"]');

  // Submit the form
  await Promise.all([
    page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
    page.click(
      'input[type="submit"][name="save"], input[type="submit"][value="Save"]',
    ),
  ]);

  //await page.waitForLoadState("domcontentloaded").catch(() => {});

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

  await browser.close();

  // Return debugging/confirmation data to Lambda test output
  return {
    //baselineEditUrl,
    finalUrl: page.url(),
    //likelySaved:
    //  resultHtml.includes("baseline") &&
    //  !resultHtml.includes("Create a new baseline"),
    snippet: resultHtml.substring(0, 2000),
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
// e.g. findUrlByPath(data, ["invoices", "all"]) -> the Invoices "All" url,
//      not the Charges/slips "all" url.
function findUrlByPath(items, path) {
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
