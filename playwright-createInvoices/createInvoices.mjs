import { chromium } from "playwright-extra";
import chromiumAws from "@sparticuz/chromium";
import stealth from "puppeteer-extra-plugin-stealth";
chromium.use(stealth());

// AWS Lambda entry point
export const handler = async () => {
  // Start headless Chromium using the Lambda-compatible Chromium binary
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

  const browser = await chromium.launch(
    isLambda
      ? {
          args: chromiumAws.args,
          executablePath: await chromiumAws.executablePath(),
          headless: true,
        }
      : { headless: false }, // local headless, to keep testing against Akamai
  );

  const baseUrl = isLambda
    ? process.env.BASE_URL
    : "https://mlg-sb.app.sandbox.netsuitesuiteprojectspro.com";
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
  // or write to /tmp and pull it, or log the full b64 and paste it back

  // Fill login form from Lambda environment variables
  if (isLambda) {
    await page.fill('input[name="companyID"]', process.env.OA_COMPANY_ID);
    await page.fill('input[name="userID"]', process.env.OA_USER_ID);
    await page.fill('input[name="password"]', process.env.OA_PASSWORD);
  } else {
    await page.fill('input[name="companyID"]', "MLG SB");
    await page.fill('input[name="userID"]', "medlearning@topstepllc.com");
    await page.fill('input[name="password"]', "Spr1ng2026!");
  }

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

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  handler()
    .then((r) => console.log(r))
    .catch((e) => console.error(e));
}
