// E2E: Google Drive sync between TWO isolated browser contexts (= two devices) in real Chromium.
// Google Identity Services + Drive REST v3 are mocked via route interception (in-memory fake Drive).
// Expects the static build served at BASE (default http://localhost:3000).
import { chromium } from "playwright";
const BASE = process.env.BASE || "http://localhost:3000";
const SHOTS = "/workspace/mint-rebuild/screens";
const PASS = "sync passphrase 42";
const results = [];
async function step(name, fn) {
  try { await fn(); results.push([name, "PASS"]); console.log("PASS", name); }
  catch (e) { results.push([name, "FAIL: " + e.message.split("\n")[0]]); console.log("FAIL", name, e.message); }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fake Drive (appDataFolder)
const files = new Map(); // id -> { name, version, body, spaces }
const uploads = []; // raw uploaded bodies
let nextId = 1;
const log = [];
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" };
async function driveHandler(route) {
  const req = route.request();
  const u = new URL(req.url());
  const m = req.method();
  if (m === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
  log.push(`${m} ${u.pathname}${u.search}`);
  const json = (status, body) => route.fulfill({ status, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!(req.headers()["authorization"] || "").startsWith("Bearer fake-token-")) return json(401, { error: "no token" });
  let mm;
  if (m === "GET" && u.pathname === "/drive/v3/files") {
    if (u.searchParams.get("spaces") !== "appDataFolder") return json(403, { error: "only appDataFolder allowed" });
    const name = /name='([^']+)'/.exec(u.searchParams.get("q") || "")?.[1];
    return json(200, { files: [...files.entries()].filter(([, f]) => f.name === name).map(([id, f]) => ({ id, version: String(f.version), modifiedTime: f.mtime })) });
  }
  if (m === "GET" && (mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname)) && u.searchParams.get("alt") === "media") {
    const f = files.get(mm[1]); if (!f) return json(404, {});
    return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: f.body });
  }
  if (m === "POST" && u.pathname === "/upload/drive/v3/files") {
    const raw = req.postData() || "";
    const boundary = /boundary=(\S+)/.exec(req.headers()["content-type"])[1];
    const parts = raw.split("--" + boundary).slice(1, -1).map((p) => p.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""));
    const meta = JSON.parse(parts[0]);
    if (JSON.stringify(meta.parents) !== '["appDataFolder"]') return json(400, { error: "must be appDataFolder" });
    const id = "file" + nextId++;
    files.set(id, { name: meta.name, version: 1, body: parts[1], mtime: new Date().toISOString() });
    uploads.push(parts[1]);
    return json(200, { id, version: "1" });
  }
  if (m === "PATCH" && (mm = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) {
    const f = files.get(mm[1]); if (!f) return json(404, {});
    f.body = req.postData(); f.version++; f.mtime = new Date().toISOString(); uploads.push(f.body);
    return json(200, { id: mm[1], version: String(f.version) });
  }
  if (m === "DELETE" && (mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) {
    files.delete(mm[1]); return route.fulfill({ status: 204, headers: cors });
  }
  return json(400, { error: "unexpected " + m + " " + u.pathname });
}
const GIS_STUB = `window.google = { accounts: { oauth2: {
  initTokenClient(c) { window.__gisInit = c; return { requestAccessToken(o) {
    if (!c.scope || c.scope !== "https://www.googleapis.com/auth/drive.appdata") return c.callback({ error: "bad_scope" });
    setTimeout(() => c.callback({ access_token: "fake-token-" + Math.random().toString(36).slice(2), expires_in: 3600 }), 50);
  } }; },
  revoke(t, cb) { window.__revoked = t; cb && cb(); }
} } };`;

const browser = await chromium.launch();
const errors = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.route("https://accounts.google.com/gsi/client", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: GIS_STUB }));
  await ctx.route(/^https:\/\/www\.googleapis\.com\//, driveHandler);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  const go = async (p) => { await page.goto(BASE + p); await page.waitForLoadState("networkidle"); };
  const shot = (n) => page.screenshot({ path: `${SHOTS}/sync-${n}.png`, fullPage: true });
  return { ctx, page, go, shot };
}
async function addExpense(d, amount, merchant, label) {
  await d.go("/expenses/new/");
  await d.page.locator("select option", { hasText: "Groceries" }).waitFor({ state: "attached" });
  await d.page.getByPlaceholder("0.00").fill(amount);
  await d.page.getByPlaceholder("Store or payee").fill(merchant);
  await d.page.locator("select").selectOption({ label });
  await d.page.getByRole("button", { name: "Save expense" }).click();
  await d.page.waitForURL("**/expenses/");
  await d.page.getByText(merchant).waitFor();
}
async function configure(d) {
  await d.go("/sync/");
  await d.page.getByTestId("sync-not-configured").waitFor();
  await d.page.getByText("Advanced: use your own OAuth client ID").click();
  await d.page.getByLabel("OAuth client ID").fill("test-client.apps.googleusercontent.com");
  await d.page.getByRole("button", { name: "Save client ID" }).click();
  await d.page.getByRole("button", { name: "Connect Google Drive" }).waitFor();
}
async function unlock(d, pass, confirm, remember = true) {
  await d.page.getByLabel("Sync passphrase", { exact: true }).fill(pass);
  if (remember) await d.page.getByLabel("Remember on this device").check();
  if (confirm) await d.page.getByLabel("Confirm sync passphrase").fill(pass);
  await d.page.getByLabel("I understand there is no recovery").check();
  await d.page.getByRole("button", { name: "Unlock & sync" }).click();
}
const remoteVersion = () => [...files.values()][0]?.version ?? 0;
async function waitFor(fn, ms, what) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await sleep(200); } throw new Error("timeout: " + what); }

const A = await device("A");
const B = await device("B");

await step("A: Sync page shows 'not configured' without client ID", async () => {
  await A.go("/sync/");
  await A.page.getByText("Sync is not configured on this deployment").waitFor();
  expect((await A.page.locator("header h1").textContent()) === "Open Mint", "header not renamed");
  await A.shot("01-not-configured");
});
await step("A: add expenses locally", async () => {
  await addExpense(A, "123.45", "Costco Run", "🛒 Groceries");
  await addExpense(A, "8.10", "Tim Hortons", "🍽️ Dining");
});
await step("A: connect Drive (stubbed GIS) + set new passphrase -> first upload", async () => {
  await configure(A);
  await A.page.getByRole("button", { name: "Connect Google Drive" }).click();
  await A.page.getByLabel("Sync passphrase", { exact: true }).waitFor();
  await A.shot("02-passphrase");
  await unlock(A, PASS, true);
  await A.page.getByText("Sync set up. Use the same passphrase on your other devices.").waitFor({ timeout: 20000 });
  expect(files.size === 1, "expected 1 file in appDataFolder, got " + files.size);
  expect([...files.values()][0].name === "open-mint-sync.enc", "wrong file name");
  await A.page.getByTestId("last-synced").filter({ hasNotText: "never" }).waitFor();
  await A.shot("03-connected");
});
await step("uploaded body is ciphertext (no plaintext merchants/categories)", async () => {
  expect(uploads.length >= 1, "no uploads");
  for (const body of uploads) {
    const j = JSON.parse(body);
    expect(j.format === "open-mint-sync" && j.ct && j.iv && j.salt && j.kdf === "PBKDF2-SHA256" && j.iter === 600000, "bad envelope");
    for (const s of ["Costco", "Tim Hortons", "Groceries", "Dining", "amountCents", "12345"]) expect(!body.includes(s), `plaintext '${s}' leaked`);
  }
  console.log("   envelope keys:", Object.keys(JSON.parse(uploads[0])).join(","));
});
await step("B: wrong passphrase fails cleanly (no data imported)", async () => {
  await configure(B);
  await B.page.getByRole("button", { name: "Connect Google Drive" }).click();
  await B.page.getByLabel("Sync passphrase", { exact: true }).waitFor();
  const before = remoteVersion();
  await unlock(B, "totally wrong pass", false);
  await B.page.getByText("Wrong sync passphrase").first().waitFor({ timeout: 20000 });
  expect(remoteVersion() === before, "remote changed after wrong passphrase");
  await B.shot("04-wrong-passphrase");
  await B.go("/expenses/");
  expect((await B.page.getByText("Costco Run").count()) === 0, "data leaked into B");
});
await step("B: correct passphrase -> pulls A's data (memory-only key locks on reload; remembered key survives)", async () => {
  await B.go("/sync/");
  await unlock(B, PASS, false, false);
  await B.page.getByText("Unlocked and synced with your Drive copy.").waitFor({ timeout: 20000 });
  // Not remembered: key lives only in memory, so a reload locks sync again.
  await B.go("/sync/");
  await B.page.getByText("Locked — enter passphrase").waitFor();
  await unlock(B, PASS, false, true);
  await B.page.getByText("Unlocked and synced with your Drive copy.").waitFor({ timeout: 20000 });
  await B.go("/sync/");
  await B.page.getByText("Connected", { exact: true }).waitFor();
  await B.go("/expenses/");
  await B.page.getByText("Costco Run").waitFor();
  await B.page.getByText("Tim Hortons").waitFor();
  await B.go("/categories/");
  const n = await B.page.getByText("Default", { exact: true }).count();
  expect(n === 10, "default categories duplicated: " + n);
  await B.go("/expenses/");
  await B.shot("05-device-b-pulled");
});
await step("B: edit + delete -> auto-sync (debounced) uploads", async () => {
  const v = remoteVersion();
  await B.page.getByText("Costco Run").click();
  await B.page.waitForURL("**/expenses/edit/**");
  await B.page.waitForFunction(() => document.querySelector('input[inputmode="decimal"]')?.value === "123.45");
  await B.page.getByPlaceholder("Store or payee").fill("Costco Wholesale");
  await B.page.getByRole("button", { name: "Save changes" }).click();
  await B.page.waitForURL("**/expenses/");
  const row = B.page.locator("li", { hasText: "Tim Hortons" });
  await row.getByRole("button", { name: /delete/i }).click();
  await B.page.getByText("Tim Hortons").waitFor({ state: "detached" });
  await waitFor(() => remoteVersion() > v, 15000, "auto-sync upload from B");
  await B.shot("06-device-b-edited");
});
await step("A: Sync now -> sees B's edit and delete", async () => {
  await A.go("/sync/");
  await A.page.getByRole("button", { name: "Sync now" }).click();
  await A.page.getByText("Synced.", { exact: true }).waitFor({ timeout: 20000 });
  await A.go("/expenses/");
  await A.page.getByText("Costco Wholesale").waitFor();
  expect((await A.page.getByText("Tim Hortons").count()) === 0, "delete didn't propagate");
  await A.shot("07-device-a-merged");
});
await step("A offline edit -> syncs when back online -> B sees it", async () => {
  const v = remoteVersion();
  await A.ctx.setOffline(true);
  await addExpense(A, "5.00", "Offline Bakery", "🍽️ Dining");
  await sleep(3000);
  expect(remoteVersion() === v, "uploaded while offline?");
  await A.ctx.setOffline(false);
  await A.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(() => remoteVersion() > v, 15000, "sync after reconnect");
  await B.go("/sync/");
  await B.page.getByRole("button", { name: "Sync now" }).click();
  await B.page.getByText("Synced.", { exact: true }).waitFor({ timeout: 20000 });
  await B.go("/expenses/");
  await B.page.getByText("Offline Bakery").waitFor();
  await B.page.getByText("Costco Wholesale").waitFor();
});
await step("all uploads still ciphertext", async () => {
  for (const body of uploads) for (const s of ["Costco", "Bakery", "Tim Hortons"]) expect(!body.includes(s), "leak " + s);
  console.log("   uploads:", uploads.length, "drive calls:", log.length);
});
await step("B: delete remote copy; A: disconnect revokes token", async () => {
  await B.go("/sync/");
  await B.page.getByRole("button", { name: "Delete copy from Google Drive" }).click();
  await B.page.getByText("Remote copy deleted from Google Drive.").waitFor();
  expect(files.size === 0, "remote not deleted");
  await A.go("/sync/");
  await A.page.getByRole("button", { name: "Disconnect Google Drive" }).click();
  await A.page.getByText("Disconnected. Data on this device is untouched.").waitFor();
  expect(!!(await A.page.evaluate(() => window.__revoked)), "token not revoked");
  await A.page.getByRole("button", { name: "Connect Google Drive" }).waitFor();
  await A.shot("08-disconnected");
  await A.go("/expenses/"); await A.page.getByText("Costco Wholesale").waitFor();
});
await step("only drive.appdata endpoints used", async () => {
  expect(log.every((l) => /^(GET \/drive\/v3\/files|POST \/upload\/drive\/v3\/files|PATCH \/upload\/drive\/v3\/files|DELETE \/drive\/v3\/files)/.test(l)), "unexpected call");
  expect(log.filter((l) => l.startsWith("GET /drive/v3/files?")).every((l) => l.includes("spaces=appDataFolder")), "non-appData list");
});
await step("no page errors", async () => expect(errors.length === 0, errors.join(" | ")));

await browser.close();
console.log("\nRESULTS"); for (const [n, r] of results) console.log(`${r.startsWith("PASS") ? "✔" : "✘"} ${n}: ${r}`);
process.exit(results.every(([, r]) => r === "PASS") ? 0 : 1);
