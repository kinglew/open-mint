// End-to-end test of Plaid bank linking in real Chromium against the production build.
// Runs: a mock Plaid API (scripts/mock-plaid.mjs), the real api/ functions via scripts/local-server.mjs
// (one configured, one not), and Plaid Link stubbed at the CDN script. Requires `npm run build` first.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { MOCK_CLIENT_ID, MOCK_SECRET, startMockPlaid } from "./mock-plaid.mjs";
import { GIS_STUB, driveHandler, files as driveFiles, uploads as driveUploads } from "./fake-drive.mjs";

const SHOTS = "/workspace/mint-rebuild/screens";
const API_KEY = "om-test-key-7f3a9c";
const MOCK_PORT = 4010, PORT = 3100, PORT_OFF = 3101;
const BASE = `http://localhost:${PORT}`, BASE_OFF = `http://localhost:${PORT_OFF}`;
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const results = [];
async function step(name, fn) {
  try { await fn(); results.push([name, "PASS"]); console.log("PASS", name); }
  catch (e) { results.push([name, "FAIL: " + e.message.split("\n")[0]]); console.log("FAIL", name, e.message); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = await startMockPlaid(MOCK_PORT, { today });
let serverLog = "";
function startServer(port, env) {
  const p = spawn(process.execPath, ["scripts/local-server.mjs"], { env: { PATH: process.env.PATH, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => (serverLog += d)); p.stderr.on("data", (d) => (serverLog += d));
  return p;
}
const srv = startServer(PORT, { PLAID_CLIENT_ID: MOCK_CLIENT_ID, PLAID_SECRET: MOCK_SECRET, PLAID_ENV: "sandbox", PLAID_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, OPEN_MINT_API_KEY: API_KEY });
const srvOff = startServer(PORT_OFF, {});
for (let i = 0; i < 50; i++) { try { await fetch(BASE + "/api/plaid/status"); await fetch(BASE_OFF + "/api/plaid/status"); break; } catch { await sleep(100); } }

const LINK_STUB = `window.Plaid = { create(cfg) {
  window.__linkTokens = (window.__linkTokens || []).concat(cfg.token);
  return { open() { setTimeout(() => cfg.onSuccess("public-sandbox-" + Math.random().toString(36).slice(2), { institution: { name: "First Platypus Bank", institution_id: "ins_109508" } }), 50); }, exit() {}, destroy() {} };
} };`;
const browser = await chromium.launch();
const errors = [];
async function device(name, base = BASE) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => localStorage.setItem("openmint.debug", "1"));
  await ctx.route("https://accounts.google.com/gsi/client", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: GIS_STUB }));
  await ctx.route(/^https:\/\/www\.googleapis\.com\//, driveHandler);
  await ctx.route("https://cdn.plaid.com/link/v2/stable/link-initialize.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: LINK_STUB }));
  const page = await ctx.newPage();
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  const go = async (p) => { await page.goto(base + p); await page.waitForLoadState("networkidle"); };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/bank-${n}.png`, fullPage: true });
  const q = async (sql, params = []) => { await page.waitForFunction(() => !!window.__openMint); return page.evaluate(([s, p]) => window.__openMint.query(s, p), [sql, params]); };
  return { ctx, page, go, shot, q, dialogs };
}
const post = (base, route, body, headers = {}) => fetch(`${base}/api/plaid/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const control = (body) => fetch(`http://127.0.0.1:${MOCK_PORT}/__control`, { method: "POST", body: JSON.stringify(body) });
const syncCalls = () => mock.state.calls.filter((c) => c === "/transactions/sync").length;
const bankRows = (q) => q("SELECT id, merchant, amountCents, pending, externalId, deleted, userEdited, categoryId FROM txn WHERE source='bank' ORDER BY merchant");

// ---------------------------------------------------------------------------
await step("not configured: Bank page explains, API returns 503 without details", async () => {
  const d = await device("off", BASE_OFF);
  await d.go("/bank/");
  await d.page.getByTestId("bank-not-configured").waitFor();
  await d.page.getByText("Bank linking is not configured on this deployment").waitFor();
  await d.shot("01-not-configured");
  const r = await post(BASE_OFF, "verify", {}, { "X-Open-Mint-Key": "anything" });
  expect(r.status === 503, "expected 503, got " + r.status);
  const s = await (await fetch(BASE_OFF + "/api/plaid/status")).json();
  expect(s.configured === false && s.env === null, JSON.stringify(s));
  await d.ctx.close();
});

await step("API key gate: missing/wrong key -> 401; Plaid never called", async () => {
  const before = mock.state.calls.length;
  for (const [hdr, label] of [[{}, "missing"], [{ "X-Open-Mint-Key": "wrong" }, "wrong"]]) {
    const r = await post(BASE, "link-token", { client_user_id: "x" }, { ...hdr, "X-Forwarded-For": "10.1.1.1" });
    expect(r.status === 401, `${label} key: ${r.status}`);
  }
  for (const route of ["exchange", "transactions-sync", "accounts", "item-remove"]) {
    const r = await post(BASE, route, { access_token: "access-sandbox-x", public_token: "public-sandbox-x" }, { "X-Forwarded-For": "10.1.1.2" });
    expect(r.status === 401, `${route}: ${r.status}`);
  }
  expect(mock.state.calls.length === before, "Plaid was called without a valid key");
});
await step("brute-force lockout after 10 bad keys (even the right key then gets 429)", async () => {
  const h = (k) => ({ "X-Open-Mint-Key": k, "X-Forwarded-For": "10.9.9.9" });
  for (let i = 0; i < 10; i++) expect((await post(BASE, "verify", {}, h("bad" + i))).status === 401, "bad key not 401");
  const r = await post(BASE, "verify", {}, h(API_KEY));
  expect(r.status === 429, "expected 429 lockout, got " + r.status);
  expect((await post(BASE, "verify", {}, { "X-Open-Mint-Key": API_KEY, "X-Forwarded-For": "10.9.9.10" })).status === 200, "other client should pass");
});
await step("rate limit: >120 req/min from one client -> 429", async () => {
  let last = 0;
  for (let i = 0; i < 125; i++) last = (await post(BASE, "verify", {}, { "X-Open-Mint-Key": API_KEY, "X-Forwarded-For": "10.8.8.8" })).status;
  expect(last === 429, "expected 429, got " + last);
});
await step("input validation: malformed body/token -> 400", async () => {
  const h = { "X-Open-Mint-Key": API_KEY, "X-Forwarded-For": "10.7.7.7" };
  const r1 = await fetch(BASE + "/api/plaid/exchange", { method: "POST", headers: h, body: "not json" });
  expect(r1.status === 400, "bad json: " + r1.status);
  const r2 = await post(BASE, "exchange", { public_token: "a b c" }, h);
  expect(r2.status === 400, "bad token: " + r2.status);
});

const A = await device("A");
let coffeeId;
await step("Bank page: wrong key rejected in UI, right key saved", async () => {
  await A.go("/bank/");
  await A.page.getByTestId("bank-key-form").waitFor();
  await A.page.getByLabel("Open Mint API key").fill("not-the-key");
  await A.page.getByRole("button", { name: "Save key" }).click();
  await A.page.getByRole("alert").getByText("Missing or wrong Open Mint API key").waitFor();
  await A.shot("02-key-gate");
  await A.page.getByLabel("Open Mint API key").fill(API_KEY);
  await A.page.getByRole("button", { name: "Save key" }).click();
  await A.page.getByText("API key saved on this device.").waitFor();
  await A.page.getByTestId("trial-cap").getByText("0 of 10 lifetime connections").waitFor();
});
await step("Link a bank: Trial cap warning, Link, exchange, paginated import + balances", async () => {
  await A.page.getByRole("button", { name: "Link a bank" }).click();
  await A.page.getByText("Bank linked and synced.").waitFor({ timeout: 20000 });
  const dlg = A.dialogs.at(-1) || "";
  expect(dlg.includes("1 of your 10 lifetime Plaid Trial connections") && dlg.includes("0 used, 10 left") && dlg.includes("does NOT give the slot back"), "cap warning: " + dlg);
  await A.page.getByTestId("bank-item").getByText("First Platypus Bank").waitFor();
  await A.page.getByTestId("bank-account").filter({ hasText: "Plaid Checking" }).getByText("$1200.50").waitFor();
  await A.page.getByTestId("bank-account").filter({ hasText: "Plaid Credit Card" }).getByText("$300.25").waitFor();
  await A.page.getByTestId("bank-networth").getByText("$900.25").waitFor();
  await A.page.getByTestId("trial-cap").getByText("1 of 10 lifetime connections").waitFor();
  await A.shot("03-linked");
  expect(syncCalls() === 3, "expected 3 paginated sync calls, got " + syncCalls());
  const rows = await bankRows(A.q);
  expect(rows.length === 5 && rows.every((r) => !r.deleted), "rows: " + rows.length);
  const cat = Object.fromEntries((await A.q("SELECT t.merchant, c.name FROM txn t JOIN category c ON c.id=t.categoryId WHERE t.source='bank'")).map((r) => [r.merchant, r.name]));
  expect(cat["Whole Foods"] === "Groceries" && cat["ACME Payroll"] === "Income" && cat["Credit Card Payment"] === "Transfers" && cat["Netflix"] === "Entertainment" && cat["Blue Bottle Coffee"] === "Dining", JSON.stringify(cat));
  const coffee = rows.find((r) => r.merchant === "Blue Bottle Coffee");
  expect(coffee.pending === 1, "coffee should be pending"); coffeeId = coffee.id;
  const payroll = rows.find((r) => r.merchant === "ACME Payroll");
  expect(payroll.amountCents === -250000, "payroll sign: " + payroll.amountCents);
});
await step("access token stored sealed with the device key (never plaintext)", async () => {
  const [it] = await A.q("SELECT accessTokenEnc, cursor FROM link_item");
  expect(it.accessTokenEnc.startsWith("dk1:"), "not sealed: " + it.accessTokenEnc.slice(0, 8));
  expect(!mock.state.accessTokens.some((t) => it.accessTokenEnc.includes(t)), "plaintext token in DB");
  expect(!!it.cursor, "cursor not saved");
});
await step("Expenses list shows bank rows with Bank + pending badges", async () => {
  await A.go("/expenses/");
  const row = A.page.getByTestId("expense-row").filter({ hasText: "Blue Bottle Coffee" });
  await row.getByText("pending").waitFor();
  await A.page.getByTestId("expense-row").filter({ hasText: "Whole Foods" }).getByText(/Bank/).waitFor();
  await A.shot("04-expenses");
});
await step("re-sync is idempotent (no duplicates)", async () => {
  await A.go("/bank/");
  await A.page.getByRole("button", { name: "Sync now" }).click();
  await A.page.getByText("Synced 1 bank.").waitFor({ timeout: 15000 });
  const rows = await bankRows(A.q);
  expect(rows.length === 5, "rows after re-sync: " + rows.length);
});
await step("pending -> posted: same row re-keyed, user's category edit preserved", async () => {
  await A.go(`/expenses/edit/?id=${coffeeId}`);
  await A.page.waitForFunction(() => document.querySelector('input[inputmode="decimal"]')?.value === "4.75");
  await A.page.locator("select").selectOption({ label: "🎬 Entertainment" });
  await A.page.getByRole("button", { name: "Save changes" }).click();
  await A.page.waitForURL("**/expenses/");
  await control({ action: "post_pending" });
  await A.go("/bank/");
  await A.page.getByRole("button", { name: "Sync now" }).click();
  await A.page.getByText("Synced 1 bank.").waitFor({ timeout: 15000 });
  const rows = (await bankRows(A.q)).filter((r) => r.merchant === "Blue Bottle Coffee");
  expect(rows.length === 1, "coffee rows: " + rows.length);
  const r = rows[0];
  expect(r.id === coffeeId && r.pending === 0 && r.amountCents === 525 && r.externalId === "txn-posted-coffee" && !r.deleted, JSON.stringify(r));
  const [c] = await A.q("SELECT c.name FROM txn t JOIN category c ON c.id=t.categoryId WHERE t.id=?", [coffeeId]);
  expect(c.name === "Entertainment", "category overwritten: " + c.name);
});
await step("removed transaction -> tombstoned and hidden", async () => {
  await control({ action: "remove", id: "txn-netflix" });
  await A.page.getByRole("button", { name: "Sync now" }).click();
  await A.page.getByText("Synced 1 bank.").waitFor({ timeout: 15000 });
  const n = (await bankRows(A.q)).find((r) => r.merchant === "Netflix");
  expect(n && n.deleted === 1, "netflix not tombstoned");
  await A.go("/expenses/");
  await A.page.getByText("Whole Foods").waitFor();
  expect((await A.page.getByText("Netflix").count()) === 0, "Netflix still listed");
});
await step("merchant rule applied on import", async () => {
  await A.go("/bank/");
  await A.page.getByLabel("Rule merchant text").fill("uber");
  await A.page.getByLabel("Rule category").selectOption({ label: "🍽️ Dining" });
  await A.page.getByRole("button", { name: "Add", exact: true }).click();
  await A.page.getByTestId("bank-rule").getByText("“uber”").waitFor();
  await control({ action: "add", id: "txn-uber", name: "Uber Eats", amount: 23.4, primary: "TRANSPORTATION", detailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES" });
  await A.page.getByRole("button", { name: "Sync now" }).click();
  await A.page.getByText("Synced 1 bank.").waitFor({ timeout: 15000 });
  const [c] = await A.q("SELECT c.name FROM txn t JOIN category c ON c.id=t.categoryId WHERE t.externalId='txn-uber'");
  expect(c?.name === "Dining", "uber category: " + c?.name);
  await A.shot("05-rules");
});
await step("ITEM_LOGIN_REQUIRED -> Login required + Reconnect (update mode) -> healthy", async () => {
  await control({ action: "error", code: "ITEM_LOGIN_REQUIRED" });
  await A.page.getByRole("button", { name: "Sync now" }).click();
  await A.page.getByText("Synced 0, 1 need attention.").waitFor({ timeout: 15000 });
  await A.page.getByTestId("bank-item-status").getByText("Login required").waitFor();
  await A.page.getByText("Last error: ITEM_LOGIN_REQUIRED").waitFor();
  await A.shot("06-login-required");
  await A.page.getByRole("button", { name: "Reconnect" }).click();
  await A.page.getByText("Reconnected and synced.").waitFor({ timeout: 15000 });
  await A.page.getByTestId("bank-item-status").getByText("Connected").waitFor();
  const toks = await A.page.evaluate(() => window.__linkTokens);
  expect(toks.at(-1).startsWith("link-update-"), "reconnect did not use update mode: " + toks.at(-1));
  expect(mock.state.accessTokens.length === 1, "reconnect must not create a new Item");
});
await step("Dashboard: balances, net worth; transfers/income not counted as spend", async () => {
  await A.go("/");
  await A.page.getByTestId("dash-accounts").getByText("Plaid Checking").waitFor();
  await A.page.getByTestId("dash-networth").getByText("$900.25").waitFor();
  // spend = Whole Foods 54.20 + coffee 5.25 + Uber 23.40 (payroll = income, CC payment = transfer, Netflix removed)
  await A.page.getByText("$82.85").first().waitFor();
  await A.page.getByText("Income this month: $2500.00").waitFor();
  await A.shot("07-dashboard");
});
await step("auto-sync on app open, throttled", async () => {
  await A.page.evaluate(() => localStorage.setItem("openmint.bank.lastAutoSync", new Date(Date.now() - 5 * 3600e3).toISOString()));
  const before = syncCalls();
  await A.go("/");
  for (let i = 0; i < 50 && syncCalls() === before; i++) await sleep(100);
  expect(syncCalls() > before, "no auto-sync on open");
  await sleep(500);
  const mid = syncCalls();
  await A.go("/expenses/"); await A.page.reload(); await sleep(1500);
  expect(syncCalls() === mid, "auto-sync not throttled");
});
let backupPath;
await step("token travels in encrypted backup; device B restores and syncs without re-linking", async () => {
  await A.go("/backup/");
  await A.page.getByLabel("Export passphrase").fill("correct horse battery");
  await A.page.getByLabel("Confirm passphrase").fill("correct horse battery");
  const dl = A.page.waitForEvent("download");
  await A.page.getByRole("button", { name: "Export backup" }).click();
  backupPath = `${SHOTS}/../e2e-bank-backup.mintbackup`;
  await (await dl).saveAs(backupPath);
  const txt = readFileSync(backupPath, "utf8");
  expect(!mock.state.accessTokens.some((t) => txt.includes(t)) && !txt.includes("Whole Foods"), "backup leaks plaintext");
  const B = await device("B");
  await B.go("/backup/");
  await B.page.getByLabel("Backup file").setInputFiles(backupPath);
  await B.page.getByLabel("Import passphrase").fill("correct horse battery");
  await B.page.getByRole("button", { name: "Import backup" }).click();
  await B.page.getByText(/Restored/).waitFor({ timeout: 20000 });
  await B.go("/bank/");
  await B.page.getByLabel("Open Mint API key").fill(API_KEY);
  await B.page.getByRole("button", { name: "Save key" }).click();
  await B.page.getByText("API key saved on this device.").waitFor();
  await B.page.getByTestId("bank-item").getByText("First Platypus Bank").waitFor();
  await control({ action: "add", id: "txn-b", name: "Corner Store", amount: 7.1 });
  await B.page.getByRole("button", { name: "Sync now" }).click();
  await B.page.getByText("Synced 1 bank.").waitFor({ timeout: 15000 });
  const [it] = await B.q("SELECT accessTokenEnc FROM link_item");
  expect(it.accessTokenEnc.startsWith("dk1:"), "B token not sealed");
  const live = (await bankRows(B.q)).filter((r) => !r.deleted);
  // Whole Foods, coffee, payroll, CC payment, Uber (Netflix removed) + the new Corner Store = 6, no duplicates
  expect(live.length === 6 && new Set(live.map((r) => r.externalId)).size === 6 && live.some((r) => r.merchant === "Corner Store"), "B rows: " + live.map((r) => r.merchant));
  expect(mock.state.accessTokens.length === 1, "B must reuse the same Item");
  await B.ctx.close();
});
async function driveConnect(d) {
  await d.go("/sync/");
  await d.page.getByText("Advanced: use your own OAuth client ID").click();
  await d.page.getByLabel("OAuth client ID").fill("test-client.apps.googleusercontent.com");
  await d.page.getByRole("button", { name: "Save client ID" }).click();
  await d.page.getByRole("button", { name: "Connect Google Drive" }).click();
  await d.page.getByLabel("Sync passphrase", { exact: true }).fill("drive sync pass 42");
  await d.page.getByLabel("Confirm sync passphrase").fill("drive sync pass 42");
  await d.page.getByLabel("I understand there is no recovery").check();
  await d.page.getByRole("button", { name: "Unlock & sync" }).click();
}
await step("E2E-encrypted Drive sync carries bank tables + token; device C syncs the bank with no duplicates", async () => {
  await driveConnect(A);
  await A.page.getByText("Sync set up. Use the same passphrase on your other devices.").waitFor({ timeout: 30000 });
  const C = await device("C");
  await driveConnect(C);
  await C.page.getByText("Unlocked and synced with your Drive copy.").waitFor({ timeout: 30000 });
  await C.go("/bank/");
  await C.page.getByLabel("Open Mint API key").fill(API_KEY);
  await C.page.getByRole("button", { name: "Save key" }).click();
  await C.page.getByTestId("bank-item").getByText("First Platypus Bank").waitFor();
  await C.page.getByTestId("bank-account").filter({ hasText: "Plaid Checking" }).waitFor();
  await C.page.getByRole("button", { name: "Sync now" }).click();
  await C.page.getByText("Synced 1 bank.").waitFor({ timeout: 15000 });
  const live = (await bankRows(C.q)).filter((r) => !r.deleted);
  expect(live.length === 6 && new Set(live.map((r) => r.externalId)).size === 6, "C rows: " + live.map((r) => r.merchant));
  const [it] = await C.q("SELECT accessTokenEnc FROM link_item");
  expect(it.accessTokenEnc?.startsWith("dk1:"), "C token not re-sealed");
  const [rule] = await C.q("SELECT pattern FROM category_rule WHERE deleted=0");
  expect(rule?.pattern === "uber", "rule not synced");
  expect(driveFiles.size === 1 && driveUploads.length > 0, "nothing uploaded to Drive");
  const leaks = driveUploads.filter((u) => mock.state.accessTokens.some((t) => u.includes(t)) || u.includes("Whole Foods") || u.includes("First Platypus"));
  expect(leaks.length === 0, "plaintext in Drive upload");
  await C.ctx.close();
});
await step("remove item: warning shown, Plaid revoked, cap count unchanged, history kept", async () => {
  await A.go("/bank/");
  await A.page.getByRole("button", { name: "Remove" }).click();
  await A.page.getByText("Bank removed. Imported transactions were kept.").waitFor({ timeout: 15000 });
  const dlg = A.dialogs.at(-1) || "";
  expect(dlg.includes("does NOT free up a connection slot"), "remove warning: " + dlg);
  expect(mock.state.items.size === 0 && mock.state.calls.includes("/item/remove"), "Plaid item not removed");
  expect((await A.page.getByTestId("bank-item").count()) === 0, "item still listed");
  await A.page.getByTestId("trial-cap").getByText("1 of 10 lifetime connections").waitFor();
  const [it] = await A.q("SELECT deleted, accessTokenEnc FROM link_item");
  expect(it.deleted === 1 && it.accessTokenEnc === null, "token not wiped");
  expect((await bankRows(A.q)).filter((r) => !r.deleted).length >= 4, "history lost");
  await A.shot("08-removed");
});
await step("server logs contain no tokens, keys, secrets or financial data", async () => {
  const forbidden = [...mock.state.accessTokens, ...mock.state.publicTokens, API_KEY, MOCK_SECRET, "Whole Foods", "Blue Bottle", "Netflix", "ACME", "Uber", "Corner Store", "1200.5", "Secret St", "Plaid Checking", "link-sandbox-", "link-update-"];
  const leaks = forbidden.filter((f) => serverLog.includes(f));
  expect(leaks.length === 0, "leaked: " + leaks.join(", "));
  expect(serverLog.includes('"evt":"rejected"') && serverLog.includes('"evt":"plaid_error"'), "expected PII-free rejection/error events in log");
  console.log("   server log lines:", serverLog.trim().split("\n").length, "| sample:", serverLog.trim().split("\n").slice(1, 3).join(" "));
});
await step("no page errors", async () => expect(errors.length === 0, errors.join(" | ")));

await browser.close();
srv.kill(); srvOff.kill(); mock.server.close();
console.log("\nRESULTS"); for (const [n, r] of results) console.log(`${r.startsWith("PASS") ? "✔" : "✘"} ${n}: ${r}`);
process.exit(results.every(([, r]) => r === "PASS") ? 0 : 1);
