// Local stand-in for Vercel: serves the static export in out/ and runs api/**/*.mjs functions
// (Web-standard `export function GET/POST(request)` handlers) on the same origin.
// Usage: PORT=3000 node scripts/local-server.mjs   (env vars are passed to the functions as on Vercel)
// This server itself logs nothing per request.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "out");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".gz": "application/gzip", ".traineddata": "application/octet-stream" };

async function serveApi(req, res, path) {
  const name = path.replace(/^\/api\//, "").replace(/\/$/, "");
  if (!/^[\w\-/]+$/.test(name) || name.split("/").some((s) => s.startsWith("_"))) return send(res, 404, "Not found");
  let mod;
  try { mod = await import(pathToFileURL(join(ROOT, "api", name + ".mjs")).href); } catch { return send(res, 404, "Not found"); }
  const fn = mod[req.method];
  if (typeof fn !== "function") return send(res, 405, "Method not allowed");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", req.socket.remoteAddress || "");
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const r = await fn(request);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}
function send(res, status, body, type = "text/plain") { res.writeHead(status, { "Content-Type": type }); res.end(body); }

async function serveStatic(res, path) {
  let p = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, "");
  let file = join(OUT, p);
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, "index.html");
  } catch {
    try { await stat(file + ".html"); file += ".html"; } catch { file = join(OUT, "404.html"); res.statusCode = 404; }
  }
  try {
    const body = await readFile(file);
    const headers = { "Content-Type": TYPES[extname(file)] || "application/octet-stream" };
    if (p === "/sw.js") Object.assign(headers, { "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
    res.writeHead(res.statusCode || 200, headers);
    res.end(body);
  } catch { send(res, 404, "Not found"); }
}

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  (path.startsWith("/api/") ? serveApi(req, res, path) : serveStatic(res, path)).catch(() => send(res, 500, "Server error"));
}).listen(PORT, () => console.log(`open-mint local server on http://localhost:${PORT} (static out/ + api/)`));
