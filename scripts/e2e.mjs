// End-to-end check of the static build in real Chromium. Expects `npm run start` on :3000.
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:3000";
const SHOTS = "/workspace/mint-rebuild/screens";
const RECEIPT = `${SHOTS}/sample-receipt.png`;
const PASS = "correct horse battery";
const results = [];
async function step(name, fn) {
  try { await fn(); results.push([name, "PASS"]); console.log("PASS", name); }
  catch (e) { results.push([name, "FAIL: " + e.message.split("\n")[0]]); console.log("FAIL", name, e.message); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
let page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const go = async (p) => { await page.goto(BASE + p); await page.waitForLoadState("networkidle"); };

await step("load app (static build, no API)", async () => {
  await go("/");
  await page.getByText("No expenses this month yet").waitFor({ timeout: 15000 });
  await shot("01-dashboard-empty");
});
await step("default categories seeded in-browser", async () => {
  await go("/categories/");
  for (const n of ["Groceries", "Dining", "Income", "Other"]) await page.getByText(n, { exact: true }).first().waitFor();
  const cnt = await page.getByText("Default", { exact: true }).count();
  expect(cnt === 10, `expected 10 defaults, got ${cnt}`);
  await page.getByPlaceholder("New category name").fill("Pets");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByText("Pets", { exact: true }).waitFor();
  await shot("02-categories");
});
await step("add expense", async () => {
  await go("/expenses/new/");
  await page.locator("select option", { hasText: "Groceries" }).waitFor({ state: "attached" });
  await page.getByPlaceholder("0.00").fill("42.50");
  await page.getByPlaceholder("Store or payee").fill("Loblaws");
  await page.locator("select").selectOption({ label: "🛒 Groceries" });
  await page.getByRole("button", { name: "Save expense" }).click();
  await page.waitForURL("**/expenses/");
  await page.getByText("Loblaws").waitFor();
  await shot("03-expenses");
});
await step("edit expense", async () => {
  await page.getByText("Loblaws").click();
  await page.waitForURL("**/expenses/edit/**");
  const amt = page.getByPlaceholder("0.00");
  await page.waitForFunction(() => document.querySelector('input[inputmode="decimal"]')?.value === "42.50");
  await amt.fill("45.00");
  await page.getByPlaceholder("Store or payee").fill("Loblaws Queen St");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForURL("**/expenses/");
  await page.getByText("Loblaws Queen St").waitFor();
  await page.getByText("$45.00").waitFor();
});
await step("set budget + progress updates", async () => {
  await go("/budgets/");
  const li = page.locator("li", { hasText: "Groceries" });
  await li.getByRole("button", { name: "Set budget" }).click();
  await li.getByPlaceholder("0.00").fill("100");
  await li.getByRole("button", { name: "Save" }).click();
  await li.getByText("45% used").waitFor();
  await shot("04-budgets");
  await go("/");
  await page.getByText("$55.00 left of $100.00 budget").waitFor();
  await page.getByText("45% used").waitFor();
  await shot("05-dashboard-progress");
});
await step("reload persists (OPFS)", async () => {
  await page.reload(); await page.waitForLoadState("networkidle");
  await page.getByText("Loblaws Queen St").waitFor();
  await page.getByText("45% used").waitFor();
  const opfs = await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); const n = []; for await (const k of r.keys()) n.push(k); return n; });
  expect(opfs.length > 0, "OPFS empty");
  console.log("   OPFS entries:", opfs);
});
await step("OCR receipt -> review -> save (source=ocr)", async () => {
  await go("/receipts/new/");
  await page.locator('input[type="file"]').setInputFiles(RECEIPT);
  await page.getByText("Review OCR results").waitFor({ timeout: 120000 });
  await shot("06-ocr-review");
  const merchant = await page.getByPlaceholder("Store or payee").inputValue();
  const amount = await page.getByPlaceholder("0.00").inputValue();
  const date = await page.locator('input[type="date"]').inputValue();
  console.log("   OCR parsed:", { merchant, amount, date });
  expect(amount === "26.76", "amount parsed as " + amount);
  await page.getByRole("button", { name: "Confirm & save expense" }).click();
  await page.waitForURL("**/expenses/");
  await page.getByText("OCR", { exact: false }).first().waitFor();
  await shot("07-expenses-with-ocr");
});
let backupPath;
await step("export encrypted backup", async () => {
  await go("/backup/");
  await page.getByLabel("Export passphrase").fill(PASS);
  await page.getByLabel("Confirm passphrase").fill(PASS);
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const d = await dl;
  backupPath = `${SHOTS}/../e2e-backup.mintbackup`;
  await d.saveAs(backupPath);
  const { readFileSync } = await import("node:fs");
  const txt = readFileSync(backupPath, "utf8");
  expect(txt.includes('"ct"') && !txt.includes("Loblaws"), "backup not encrypted");
  await page.getByText("Encrypted backup downloaded").waitFor();
  await shot("08-backup");
});
await step("offline reload works (service worker)", async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await go("/"); // ensure controlled
  await ctx.setOffline(true);
  await page.reload(); await page.waitForLoadState("domcontentloaded");
  await page.getByText("Loblaws Queen St").waitFor({ timeout: 15000 });
  await go("/expenses/new/");
  await page.locator("select option", { hasText: "Dining" }).waitFor({ state: "attached" });
  await page.getByPlaceholder("0.00").fill("12.00");
  await page.getByPlaceholder("Store or payee").fill("Offline Cafe");
  await page.locator("select").selectOption({ label: "🍽️ Dining" });
  await page.getByRole("button", { name: "Save expense" }).click();
  await page.getByText("Offline Cafe").waitFor();
  await shot("09-offline");
  await ctx.setOffline(false);
});
await step("clear storage -> data gone", async () => {
  await page.goto("about:blank");
  await page.close();
  const p2 = await ctx.newPage();
  await p2.goto(BASE + "/backup/");
  await p2.evaluate(async () => { const r = await navigator.storage.getDirectory(); for await (const k of r.keys()) await r.removeEntry(k, { recursive: true }); });
  await p2.close();
  page = await ctx.newPage(); page.on("dialog", (d) => d.accept()); page.on("pageerror", (e) => errors.push(e.message));
  await go("/");
  await page.getByText("No expenses this month yet").waitFor({ timeout: 15000 });
});
await step("wrong passphrase rejected", async () => {
  await go("/backup/");
  await page.getByLabel("Backup file").setInputFiles(backupPath);
  await page.getByLabel("Import passphrase").fill("wrong pass");
  await page.getByRole("button", { name: "Import backup" }).click();
  await page.getByText("Wrong passphrase or corrupted file").waitFor({ timeout: 20000 });
});
await step("import backup restores data", async () => {
  await page.getByLabel("Import passphrase").fill(PASS);
  await page.getByRole("button", { name: "Import backup" }).click();
  await page.getByText(/Restored 2 expenses, 1 budgets, 11 categories/).waitFor({ timeout: 20000 });
  await shot("10-restored");
  await go("/");
  await page.getByText("Loblaws Queen St").waitFor();
  await page.getByText("45% used").waitFor();
  await go("/categories/"); await page.getByText("Pets", { exact: true }).waitFor();
  await go("/expenses/"); await shot("11-expenses-restored");
});
await step("no page errors", async () => expect(errors.length === 0, errors.join(" | ")));

await browser.close();
console.log("\nRESULTS"); for (const [n, r] of results) console.log(`${r.startsWith("PASS") ? "✔" : "✘"} ${n}: ${r}`);
process.exit(results.every(([, r]) => r === "PASS") ? 0 : 1);
