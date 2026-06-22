# createInvoices Lambda — Maintenance & Deployment Runbook

**Purpose:** How to edit, deploy, and test the `createInvoices` function
**Audience:** Developers on the team using VS Code on Windows.
**Last updated:** 2026-06-22

---

## 1. What this function is (read this first)

`createInvoices` automates **bulk invoice creation in SuiteProjects Pro (SPP)** for the client **MLG**, against the sandbox `mlg-sb.app.sandbox.netsuitesuiteprojectspro.com`.

It does this by **driving the SPP web UI with a headless browser (Playwright)** — logging in, walking the menus, and submitting the invoice form. **This is deliberate:** the specific operation cannot be done through the SPP API, which is why we automate the UI instead.

Because it scrapes an undocumented UI, **this function is inherently fragile** (see _Failure modes_ and _Fragility_). It can break with no code change on our side. That is expected. The job of this runbook is to make breaks fast to diagnose.

**Key facts:**

| Item        | Value                                                                          |
| ----------- | ------------------------------------------------------------------------------ |
| Repo        | `agency-lambda-repo` (monorepo)                                                |
| Folder      | `C:\repository\agency-lambda-repo\playwright-createInvoices\`                  |
| Source file | `createInvoices.mjs`                                                           |
| Packaging   | **Container image** (Docker → ECR → Lambda), _not_ a zip                       |
| AWS region  | `us-east-2`                                                                    |
| ECR repo    | `776528084998.dkr.ecr.us-east-2.amazonaws.com/playwright`                      |
| Credentials | Lambda **environment variables**: `OA_COMPANY_ID`, `OA_USER_ID`, `OA_PASSWORD` |

---

## 2. Prerequisites (one-time setup)

Make sure you have:

- **VS Code** (Windows)
- **Docker Desktop** — installed and **running** (the build won't work if Docker isn't started)
- **AWS CLI v2** — configured with credentials that can push to ECR and update the Lambda
- **Node.js** (for local testing) — match the runtime version the image uses
- **Access** to: the AWS account (`776528084998`), the ECR repo, and the Lambda function in **us-east-2**

---

## 3. The development loop at a glance

```
edit code  →  test LOCALLY first  →  build image (NEW tag)  →  push to ECR
          →  point Lambda at new image  →  WAIT for propagation  →  test on Lambda
          →  verify the invoice actually exists in the SPP UI
```

---

## 4. Make a change

1. Open the folder in VS Code:
   `C:\repository\agency-lambda-repo\playwright-createInvoices\`
2. Edit `createInvoices.mjs`.
3. Commit your change to the repo as normal.

The file is structured as a Lambda handler (`export const handler = ...`) with a local-run shim at the bottom:

```js
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  handler().then(...).catch(...);
}
```

That shim is what lets you run it on your own machine — see next section.

---

## 5. Test locally FIRST (fast loop)

Local testing is dramatically faster than deploy-and-test, and it's also how we diagnose bot-detection issues. **Always do this before building an image.**

### One-time local dependency install

From inside the function folder:

```powershell
cd C:\repository\agency-lambda-repo\playwright-createInvoices
npm install playwright-core @sparticuz/chromium playwright-extra puppeteer-extra-plugin-stealth
npm install -D playwright
npx playwright install chromium
```

> If `npm install` behaves oddly, the monorepo may use **workspaces** (deps hoisted to repo root). In that case install at the repo root instead. Check for a `"workspaces"` field in the root `package.json`.

### How local vs. Lambda is detected

The launch code branches on `AWS_LAMBDA_FUNCTION_NAME`, which only exists on Lambda:

```js
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
```

- **On Lambda:** uses the `@sparticuz/chromium` binary.
- **Locally:** uses full Playwright's bundled Chromium.

### Run it

You'll need the SPP credentials in your environment. In PowerShell:

```powershell
$env:OA_COMPANY_ID="<company id>"
$env:OA_USER_ID="<user id>"
$env:OA_PASSWORD="<password>"
node createInvoices.mjs
```

**Watch headed vs. headless.** Set the local launch to `{ headless: false }` to _watch_ the browser drive the form — invaluable for debugging. Set it to `{ headless: true }` to reproduce how it runs on Lambda (this is also how we test whether bot detection is blocking us — see below).

---

## 6. Build the image and push to ECR

> **Docker Desktop must be running.**

From inside the function folder:

```powershell
cd C:\repository\agency-lambda-repo\playwright-createInvoices

docker buildx build `
  --platform linux/amd64 `
  --provenance=false `
  --tag 776528084998.dkr.ecr.us-east-2.amazonaws.com/playwright:createInvoices-vXXX `
  --push .
```

(If your shell isn't PowerShell, put it on one line and drop the backticks.)

### 🚨 THE #1 RULE: use a NEW tag every single build

Replace `vXXX` with a **fresh, unique tag every time** — bump the number (`-v3`, `-v4`, …) or use a timestamp.

**Why this matters (this has bitten us repeatedly):** Lambda pins to an image **digest**, not a tag. If you re-push new code to a tag Lambda has _already seen_ (e.g. reusing `createInvoices-v2`), Lambda often keeps running the **old** image even after you "deploy." Your changes silently vanish and you waste an hour. A new tag every build makes this impossible.

A timestamp tag removes the risk of forgetting to bump:

```powershell
# Example tag: createInvoices-20260622-1430
```

If you need to authenticate to ECR first:

```powershell
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 776528084998.dkr.ecr.us-east-2.amazonaws.com
```

---

## 7. Point Lambda at the new image and deploy

**Option A — Console:** Lambda → your function → _Image_ → **Deploy new image** → select the new tag → Save.

**Option B — CLI (more reliable, forces a fresh digest resolve):**

```powershell
aws lambda update-function-code `
  --function-name playwright-createInvoices `
  --image-uri 776528084998.dkr.ecr.us-east-2.amazonaws.com/playwright:createInvoices-vXXX `
  --region us-east-2
```

### Verify the right code is actually deployed

If you suspect stale code, compare digests:

```powershell
# digest in ECR under your tag
aws ecr describe-images --repository-name playwright --image-ids imageTag=createInvoices-vXXX --region us-east-2 --query "imageDetails[0].imageDigest"

# digest Lambda is actually running
aws lambda get-function --function-name playwright-createInvoices --region us-east-2 --query "Code.ResolvedImageUri"
```

If the `@sha256:...` values don't match, Lambda is **not** running your new code — re-run the update.

### 🚨 THE #2 RULE: WAIT for propagation before testing

After deploying, the new image takes a short time to become active. **If you invoke immediately, you may run the OLD code** and think your change didn't work. Give it a minute, then test. (This has caused false "it didn't work!" panics more than once.)

A reliable way to be 100% sure which code is live: add a marker as the **first line** of the handler:

```js
export const handler = async () => {
  console.log("BUILD MARKER vXXX", new Date().toISOString());
  ...
```

Then confirm that marker shows up in the logs of your test run. No marker = you're running stale code; wait longer or re-deploy.

---

## 8. Test on Lambda

1. **Invoke** the function (Lambda console → _Test_, or a saved test event).
2. **Read CloudWatch logs** for that invocation (Lambda console → _Monitor_ → _View CloudWatch logs_ → newest log stream). All the `console.log` output goes here.
3. **Check the return value** — the function returns `finalUrl` and a `snippet`.
4. **Check the body-text log** — the function logs `BODY TEXT:` (the rendered text of the final page). This is the most human-readable indicator of what actually happened.

### ⚠️ The function does NOT reliably self-report success

Much of the submit flow swallows errors (`.catch(() => {})`), so a clean return does **not** prove an invoice was created. **The authoritative check is to log into the SPP sandbox UI by hand and confirm the invoice actually exists.** Always verify there, not just in the logs.

---

## 9. Failure modes & how to diagnose

These are the breaks we've actually hit. When something fails, match the symptom here first.

### "Access Denied" / `errors.edgesuite.net` in a response

**Cause:** Akamai (the bot-detection layer in front of SPP) is blocking us. Not our bug — it's their infrastructure. Can start happening with **no code change** on our side.
**Notes:**

- We get past it using `playwright-extra` + the stealth plugin (already wired in). If it returns, stealth may need updating, or the headless fingerprint is being flagged again.
- **Diagnose which lever:** run locally **headed** (`headless: false`) from your own machine. If headed-local works but headless/Lambda doesn't, it's the **fingerprint** (stealth's domain).
- **Side-channel trap:** any call using `page.request.get(...)` will get blocked by Akamai even when page navigation works, because it has a different fingerprint. **All requests to SPP must go through the page** (in-page `fetch` via `page.evaluate`), never `page.request`. Keep this rule if you add new SPP calls.

### `net::ERR_INSUFFICIENT_RESOURCES`

**Cause:** Chromium ran out of memory/resources in the Lambda sandbox. Often appears on **warm** containers after repeated invocations (resource accumulation), so it can show up with unchanged code.
**Fixes, in order:**

1. Raise Lambda **memory to 2048 MB+** (also scales CPU). Fastest test.
2. Ensure the browser **always closes** — the launch should be wrapped so `browser.close()` runs in a `finally`, even on failure, so leaked browsers don't pile up across warm invokes.
3. Add `--disable-dev-shm-usage` to the Chromium args (Lambda's `/dev/shm` is tiny).
4. If it persists on a **cold** start at 2048 MB, check `/tmp` (512 MB default) — bump ephemeral storage.

### Changes "didn't take" / old behavior persists

**Cause:** stale image (reused tag) **or** tested before propagation finished. See Section 7's two rules and the BUILD MARKER trick.

### `JSON.parse` error / HTML where JSON expected

**Cause:** an SPP endpoint returned an error/HTML page instead of JSON — often a blocked request, an expired `uid`, or a **moved internal endpoint** after a sandbox refresh. Log the raw response body to see which.

### Login form not found / `input` selectors time out

**Cause:** could be Akamai serving a block page (check for `edgesuite.net`), a too-early DOM read (wait for the form to render), or an SPP login change after a **sandbox refresh**.

### General first move for any weird break

The function already logs input dumps, an HTML snippet, and body text. Read those in CloudWatch. If you need a visual, capture a screenshot to S3 (Chromium can't usefully dump a full screenshot through CloudWatch). Keep these diagnostics in place — they're what make breaks fast to diagnose.

---

## 10. Fragility — set expectations & when to escalate

This function depends on two things outside our control:

1. **Akamai tolerating our stealthed headless browser** — an adversarial, continuously-updated system.
2. **Undocumented SPP internal endpoints** (the `uid` / action-menu flow) with no stability guarantee, which can shift on **sandbox refreshes**.

It will work until it doesn't, and the break will usually be **sudden and external**. Our leverage is diagnosis speed, not prevention.

**Pin dependency versions** (`@sparticuz/chromium`, `playwright`, the stealth plugin) so an incidental upgrade doesn't shift the fingerprint and trip Akamai. Upgrade those deliberately.

---

## 11. Quick reference

```powershell
# Local test
cd C:\repository\agency-lambda-repo\playwright-createInvoices
node createInvoices.mjs

# Build + push (NEW TAG EVERY TIME)
docker buildx build --platform linux/amd64 --provenance=false `
  --tag 776528084998.dkr.ecr.us-east-2.amazonaws.com/playwright:createInvoices-vXXX --push .

# Deploy
aws lambda update-function-code --function-name playwright-createInvoices `
  --image-uri 776528084998.dkr.ecr.us-east-2.amazonaws.com/playwright:createInvoices-vXXX --region us-east-2

# WAIT ~1 min, then invoke and read CloudWatch.
# Then VERIFY the invoice in the SPP sandbox UI by hand.
```
