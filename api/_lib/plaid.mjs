// Shared helpers for Open Mint's thin, stateless Plaid pass-through (Vercel Functions).
//
// Privacy rules enforced here:
//  * Nothing is persisted: no database, no files, no KV. Each request is forwarded to Plaid and the
//    response is returned to the caller's device, then dropped.
//  * Nothing financial is logged: no tokens, account data, transactions, amounts, merchants, or
//    request bodies. Only coarse events (route, reason, Plaid error code, Plaid request_id) are
//    written, with the client IP reduced to a salted, truncated hash.
//  * Access is gated by an owner-only secret (OPEN_MINT_API_KEY) sent in the X-Open-Mint-Key header.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PLAID_HOSTS = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };
const SALT = randomBytes(16).toString("hex"); // per-instance; IP hashes are not linkable across instances

export function config() {
  const env = (process.env.PLAID_ENV || "").trim().toLowerCase();
  const clientId = (process.env.PLAID_CLIENT_ID || "").trim();
  const secret = (process.env.PLAID_SECRET || "").trim();
  const apiKey = (process.env.OPEN_MINT_API_KEY || "").trim();
  // PLAID_BASE_URL is only for automated tests against a local mock Plaid server.
  const base = (process.env.PLAID_BASE_URL || "").trim() || PLAID_HOSTS[env] || "";
  const configured = !!(clientId && secret && apiKey && base);
  return { env: env || "unset", clientId, secret, apiKey, base, configured, redirectUri: (process.env.PLAID_REDIRECT_URI || "").trim() };
}

export function ipHash(request) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(SALT + ip).digest("hex").slice(0, 10);
}

/** Coarse, PII-free event log. Never pass request/response bodies here. */
export function logEvent(evt, fields = {}) {
  const safe = {};
  for (const k of ["route", "reason", "code", "type", "requestId", "status", "ip"]) if (fields[k] != null) safe[k] = String(fields[k]).slice(0, 80);
  console.warn(JSON.stringify({ app: "open-mint", evt, ...safe }));
}

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

// ---- best-effort in-memory rate limiting (per warm instance; serverless => advisory, not absolute)
const buckets = new Map();
function peek(key, windowMs) {
  const b = buckets.get(key);
  return !b || Date.now() - b.start > windowMs ? 0 : b.n;
}
function bump(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  return b.n;
}
const RATE = { limit: 120, windowMs: 60_000 }; // requests per minute per client
const FAIL = { limit: 10, windowMs: 15 * 60_000 }; // bad API keys per 15 min per client

function keyOk(given, expected) {
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

/**
 * Wrap a POST handler with config check, API-key gate, rate limiting, body parsing and safe error handling.
 * handler(body, ctx) returns a plain object; Plaid errors are thrown as PlaidError.
 */
export function guarded(route, handler) {
  return async function POST(request) {
    const ip = ipHash(request);
    const cfg = config();
    if (!cfg.configured) return json(503, { error: "not_configured", message: "Bank linking is not configured on this deployment." });
    if (peek("fail:" + ip, FAIL.windowMs) >= FAIL.limit) {
      logEvent("rejected", { route, reason: "locked_out", ip });
      return json(429, { error: "rate_limited", message: "Too many failed attempts. Try again later." }, { "Retry-After": "900" });
    }
    const given = request.headers.get("x-open-mint-key") || "";
    if (!given || !keyOk(given, cfg.apiKey)) {
      bump("fail:" + ip, FAIL.windowMs);
      logEvent("rejected", { route, reason: given ? "bad_key" : "missing_key", ip });
      return json(401, { error: "unauthorized", message: "Missing or wrong Open Mint API key." });
    }
    if (bump("rate:" + ip, RATE.windowMs) > RATE.limit) {
      logEvent("rejected", { route, reason: "rate_limited", ip });
      return json(429, { error: "rate_limited", message: "Slow down — too many requests." }, { "Retry-After": "60" });
    }
    let body = {};
    try {
      const text = await request.text();
      if (text.length > 20_000) return json(413, { error: "too_large" });
      body = text ? JSON.parse(text) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      return json(400, { error: "bad_request", message: "Body must be a JSON object." });
    }
    try {
      return json(200, await handler(body, cfg));
    } catch (e) {
      if (e instanceof PlaidError) {
        logEvent("plaid_error", { route, code: e.code, type: e.type, requestId: e.requestId, status: e.status });
        return json(e.status >= 400 && e.status < 600 ? e.status : 502, {
          error: "plaid_error", error_type: e.type, error_code: e.code, display_message: e.display, message: e.message,
        });
      }
      if (e instanceof BadInput) return json(400, { error: "bad_request", message: e.message });
      logEvent("server_error", { route, reason: e?.name || "Error" });
      return json(502, { error: "upstream_failed", message: "Could not reach Plaid." });
    }
  };
}

export class PlaidError extends Error {
  constructor(status, p) {
    super(p?.error_message || "Plaid error");
    this.status = status; this.type = p?.error_type; this.code = p?.error_code; this.display = p?.display_message || null; this.requestId = p?.request_id;
  }
}
export class BadInput extends Error {}
export function need(body, field, re = /^[\w\-:.]{1,256}$/) {
  const v = body[field];
  if (typeof v !== "string" || !re.test(v)) throw new BadInput(`Missing or invalid ${field}`);
  return v;
}

/** POST to Plaid with credentials from env. Returns parsed JSON; throws PlaidError on Plaid errors. */
export async function plaid(cfg, path, payload) {
  const res = await fetch(cfg.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...payload }),
    signal: AbortSignal.timeout(25_000),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok || data?.error_code) throw new PlaidError(res.status || 502, data || {});
  return data;
}

// ---- response minimisation: only fields the app uses leave the function
export function slimAccount(a) {
  return {
    account_id: a.account_id, name: a.name, official_name: a.official_name ?? null, mask: a.mask ?? null,
    type: a.type, subtype: a.subtype ?? null,
    balances: { current: a.balances?.current ?? null, available: a.balances?.available ?? null, iso_currency_code: a.balances?.iso_currency_code ?? a.balances?.unofficial_currency_code ?? null },
  };
}
export function slimTxn(t) {
  return {
    transaction_id: t.transaction_id, account_id: t.account_id, amount: t.amount,
    iso_currency_code: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
    date: t.date, authorized_date: t.authorized_date ?? null, name: t.name ?? null, merchant_name: t.merchant_name ?? null,
    pending: !!t.pending, pending_transaction_id: t.pending_transaction_id ?? null,
    personal_finance_category: t.personal_finance_category
      ? { primary: t.personal_finance_category.primary, detailed: t.personal_finance_category.detailed } : null,
  };
}
