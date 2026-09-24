/**
 * End-to-end walkthrough of the canvas in a real browser, with a screenshot per step.
 *   pnpm e2e                          (against http://localhost:3000, a fresh workspace)
 *   BASE=http://localhost:3000 SHOTS=./e2e-shots pnpm e2e
 * First run only: npx playwright install chromium
 * Start core and web with KUBER_DEV_SIGNIN=true. Use a fresh database: it opens a book, imports samples/hdfc_2026_10.csv and posts entries.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.BASE ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? join(ROOT, "e2e-shots");
const WORKSPACE = process.env.WORKSPACE ?? `e2e-${Date.now().toString(36)}`;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
p.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
const shot = async (name, fullPage = false) => { await p.waitForTimeout(400); await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage }); console.log("✓", name); };
async function ask(text) {
  const before = await p.locator("section.exchange").count();
  await p.fill("#ask", text); await p.keyboard.press("Enter");
  await p.waitForFunction((n) => document.querySelectorAll("section.exchange").length > n, before, { timeout: 20000 });
  return p.locator("section.exchange").first();
}

try {
  await p.goto(`${BASE}/signin`);
  // Development sign-in: needs KUBER_DEV_SIGNIN=true for both core and web (passkeys need a real authenticator).
  await p.fill("#name", "E2E Tester"); await p.fill("#workspace", WORKSPACE);
  await p.click("form.dev-form button.primary");
  await p.waitForURL(/setup/);
  await p.click("text=Freelancer").catch(() => {});
  await p.fill("#bank", "1,25,000"); await p.fill("#asOf", "2026-09-30");
  await p.click("form button.primary");
  await p.waitForURL((u) => u.pathname === "/");
  await shot("01-canvas-empty", true);

  await p.goto(`${BASE}/import`);
  await p.setInputFiles("input[type=file]", join(ROOT, "samples", "hdfc_2026_10.csv"));
  await p.click("button:has-text('Import')"); await p.waitForSelector(".result");
  await p.waitForTimeout(2500);
  await shot("02-imported");

  await p.goto(`${BASE}/`);
  let x = await ask("Post the drafts"); await shot("03-post-plan");
  await x.locator("button:has-text('Approve and post')").click(); await p.waitForTimeout(3500);
  await shot("04-posted", true);
  await ask("Reconcile bank to 1,30,206.50 as of 31 Oct 2026"); await shot("05-reconcile");
  await ask("Rebalance BANK 70 INVEST 30"); await shot("06-rebalance");
  await ask("What if rent goes up 15000 a month"); await shot("07-what-if");
  await ask("Are the books in order?"); await shot("08-balance");
  await p.goto(`${BASE}/review`); await shot("09-review");
  await p.goto(`${BASE}/reports/profit-and-loss`); await shot("10-report");
  await p.goto(`${BASE}/ledger/BANK`); await shot("11-ledger");
} finally {
  await browser.close();
}
console.log(errors.length ? `browser errors:\n${errors.join("\n")}` : "no browser errors");
console.log(`screenshots: ${SHOTS}`);
process.exit(errors.length ? 1 : 0);
