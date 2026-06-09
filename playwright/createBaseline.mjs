import { chromium } from "playwright-core";
import chromiumAws from "@sparticuz/chromium";

// AWS Lambda entry point
export const handler = async () => {
  // TODO: Replace this hardcoded ID with event.projectId later
  const projectId = "2595";

  // Start headless Chromium using the Lambda-compatible Chromium binary
  const browser = await chromium.launch({
    args: chromiumAws.args,
    executablePath: await chromiumAws.executablePath(),
    headless: true,
  });

  const page = await browser.newPage();

  // Open SuiteProjects login page
  await page.goto("https://auth.netsuitesuiteprojectspro.com/login", {
    waitUntil: "networkidle",
  });

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

  // Ask SuiteProjects for the action menu for this project.
  // This is the key endpoint that returns generated URLs with valid r= tokens.
  const actionResp = await page.request.get(
    `https://top-step.app.netsuitesuiteprojectspro.com/webapi/v2/navigation/action_menu/by_record/project/${projectId}?uid=${uid}&app=pm`,
  );

  const actionJson = JSON.parse(await actionResp.text());

  // Find the "Baseline" action URL from the returned menu JSON
  const baselineEditUrl = findUrlByName(actionJson.data, "baseline");

  if (!baselineEditUrl) {
    throw new Error("Could not find baseline_edit URL");
  }

  // Open the generated baseline creation form URL
  await page.goto(baselineEditUrl, { waitUntil: "domcontentloaded" });
  await page
    .waitForLoadState("networkidle", { timeout: 15000 })
    .catch(() => {});

  // Fill out the baseline form
  await page.fill(
    'input[name="name"]',
    `Lambda baseline ${new Date().toISOString()}`,
  );

  await page.fill(
    'textarea[name="notes"]',
    "Created from Lambda/Playwright test",
  );

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

  // Capture final page HTML for basic validation/debugging
  const resultHtml = await page.content();

  await browser.close();

  // Return debugging/confirmation data to Lambda test output
  return {
    baselineEditUrl,
    finalUrl: page.url(),
    likelySaved:
      resultHtml.includes("baseline") &&
      !resultHtml.includes("Create a new baseline"),
    snippet: resultHtml.substring(0, 2000),
  };
};

// Extract uid value from a SuiteProjects URL.
// Example: dashboard.pl?...;uid=abc123;r=xyz
function extractUid(url) {
  return url.match(/[?;]uid=([^;]+)/)?.[1];
}

// Recursively search SuiteProjects menu JSON for an item with a matching name.
// Used here to find name="baseline" and return its generated URL.
function findUrlByName(items, name) {
  for (const item of items || []) {
    if (item.name === name && item.url) return item.url;

    const nested = findUrlByName(item.items, name);
    if (nested) return nested;
  }

  return null;
}
