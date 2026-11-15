// In-memory fake Google Drive appDataFolder + GIS stub for Playwright tests (same as scripts/e2e-sync.mjs).
// ---------- fake Drive (appDataFolder)
export const files = new Map(); // id -> { name, version, body, spaces }
export const uploads = []; // raw uploaded bodies
let nextId = 1;
const log = [];
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" };
export async function driveHandler(route) {
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
export const GIS_STUB = `window.google = { accounts: { oauth2: {
  initTokenClient(c) { window.__gisInit = c; return { requestAccessToken(o) {
    if (!c.scope || c.scope !== "https://www.googleapis.com/auth/drive.appdata") return c.callback({ error: "bad_scope" });
    setTimeout(() => c.callback({ access_token: "fake-token-" + Math.random().toString(36).slice(2), expires_in: 3600 }), 50);
  } }; },
  revoke(t, cb) { window.__revoked = t; cb && cb(); }
} } };`;
