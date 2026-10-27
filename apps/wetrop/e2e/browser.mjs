import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const root = resolve(import.meta.dirname, "../../..");
const temporary = resolve(root, ".runtime/browser-tmp");
mkdirSync(temporary, { recursive: true });
process.env.TMPDIR = temporary;
const company = resolve(root, `.runtime/e2e-company-${process.pid}`);
const port = 4419;
mkdirSync(resolve(root, ".runtime"), { recursive: true });
const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/wetrop/src/server.ts"],
  {
    cwd: root,
    env: {
      ...process.env,
      WETROP_TEST_MODE: "1",
      COMPANY_ROOT: company,
      WETROP_PORT: String(port),
      WETROP_MODEL: "",
      WETROP_MODEL_URL: "",
      WETROP_TELEGRAM_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let logs = "";
child.stdout.on("data", (b) => {
  logs += b.toString();
});
child.stderr.on("data", (b) => {
  logs += b.toString();
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    if (logs.includes("Wetrop: http")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const key = readFileSync(
    resolve(root, ".runtime/access-token"),
    "utf8",
  ).trim();
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/state`, {
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  const stateResponse = await fetch(`${base}/api/state`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  assert.equal(stateResponse.status, 200);
  assert.equal(
    (await stateResponse.json()).company.name,
    "Aurora Servizi S.r.l.",
  );
  for (const path of [
    "../README.md",
    "/etc/passwd",
    ".wetrop/database/actions.db",
  ])
    assert.equal(
      (
        await fetch(`${base}/api/file?path=${encodeURIComponent(path)}`, {
          headers: { Authorization: `Bearer ${key}` },
        })
      ).status,
      400,
    );
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByLabel("Workspace access key").fill(key);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("heading", { name: "Everything in motion." }).waitFor();
  await page.screenshot({
    path: resolve(root, ".runtime/workspace-desktop.png"),
    fullPage: true,
  });
  for (const name of [
    "Documents",
    "Knowledge",
    "Calendar",
    "Reviews",
    "Activity",
    "Company",
    "Actions",
  ]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click();
    await page.waitForTimeout(100);
  }
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Documents", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /Download company-profile.json/ })
    .click();
  assert.equal((await download).suggestedFilename(), "company-profile.json");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Actions", exact: true })
    .click();
  await page.getByLabel("Message Wetrop").fill("What documents do we have?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Configure WETROP_MODEL_URL" })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(root, ".runtime/workspace-mobile.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "Mobile viewport must not overflow horizontally",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser/API smoke passed: authentication, confinement, navigation, downloads, visible configuration failure, mobile layout.",
  );
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise((r) => child.once("exit", r));
  rmSync(company, { recursive: true, force: true });
}
