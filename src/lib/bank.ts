"use client";
// Read-only bank linking via Plaid, local-first:
//  * The browser talks to /api/plaid/* — thin, stateless Vercel Functions that hold the Plaid client id/secret
//    and simply forward to Plaid. They store and log nothing financial.
//  * Access tokens come back to this device and are stored in the local SQLite DB sealed with a per-device,
//    non-extractable key (see devicekey.ts). They travel only inside the passphrase-encrypted backup or the
//    E2E-encrypted Drive sync, so your other devices can sync the same bank without re-linking.
//  * Every call carries the owner-only API key (X-Open-Mint-Key) so strangers on the public site can't burn
//    your Plaid Items or quota.
import { LOCAL_CHANGE_EVENT, listCategories, query, batch } from "./db";
import { openSecret, sealSecret } from "./devicekey";
import { TRANSFERS, categoryFor, planSync, toCents, type PlaidTxn, type Rule, type SyncPage } from "./plaid-map";

export const TRIAL_ITEM_CAP = 10;
export const AUTO_SYNC_HOURS = 4;
export const BANK_EVENT = "openmint:bank-status";
const LS_KEY = "openmint.bank.apiKey";
const LS_USER = "openmint.bank.userId";
const LS_AUTO = "openmint.bank.lastAutoSync";
const LS_OAUTH = "openmint.bank.oauth";
const LINK_JS = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export type BankStatus = { reachable: boolean; configured: boolean; env: string | null; oauthRedirect?: boolean };
export type LinkItem = {
  id: string; institutionId: string | null; institution: string | null; status: "ok" | "login_required" | "error";
  lastError: string | null; lastSyncedAt: string | null; createdAt: string; hasToken: boolean;
};
export type BankAccount = {
  id: string; itemId: string; institution: string | null; name: string; officialName: string | null; mask: string | null;
  type: string | null; subtype: string | null; currentCents: number | null; availableCents: number | null; currency: string | null; updatedAt: string | null;
};
export type CategoryRule = { id: string; pattern: string; categoryId: string; categoryName: string; categoryIcon: string | null };

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const emit = () => window.dispatchEvent(new Event(BANK_EVENT));
const changed = () => { window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT)); emit(); };

// ---------- API access
export const getApiKey = () => localStorage.getItem(LS_KEY) || "";
export function clearApiKey() { localStorage.removeItem(LS_KEY); emit(); }
function clientUserId() {
  let id = localStorage.getItem(LS_USER);
  if (!id) { id = "om-" + uid(); localStorage.setItem(LS_USER, id); }
  return id;
}

export class BankApiError extends Error {
  constructor(message: string, public status: number, public code: string | null) { super(message); }
}
let statusCache: Promise<BankStatus> | null = null;
export function getBankStatus(force = false): Promise<BankStatus> {
  if (!statusCache || force) statusCache = fetch("/api/plaid/status", { cache: "no-store" })
    .then(async (r) => {
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) return { reachable: false, configured: false, env: null };
      const j = await r.json();
      return { reachable: true, configured: !!j.configured, env: j.env ?? null, oauthRedirect: !!j.oauthRedirect };
    })
    .catch(() => { statusCache = null; return { reachable: false, configured: false, env: null }; });
  return statusCache;
}

async function api<T>(route: string, body: Record<string, unknown>, key = getApiKey()): Promise<T> {
  if (!key) throw new BankApiError("Enter your Open Mint API key first.", 401, "missing_key");
  let res: Response;
  try {
    res = await fetch(`/api/plaid/${route}`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-Open-Mint-Key": key }, body: JSON.stringify(body) });
  } catch {
    throw new BankApiError("Couldn't reach the bank service (offline?)", 0, "network");
  }
  let j: Record<string, unknown> = {};
  try { j = await res.json(); } catch {}
  if (!res.ok) {
    const code = (j.error_code as string) || (j.error as string) || null;
    const msg = (j.display_message as string) || (j.message as string) || `Bank service error ${res.status}`;
    throw new BankApiError(msg, res.status, code);
  }
  return j as T;
}

export async function saveApiKey(key: string) {
  const k = key.trim();
  if (!k) throw new Error("Enter the API key.");
  await api("verify", {}, k); // throws 401 on a wrong key
  localStorage.setItem(LS_KEY, k);
  emit();
}

// ---------- local reads
export async function listItems(): Promise<LinkItem[]> {
  const rows = await query("SELECT id,institutionId,institution,status,lastError,lastSyncedAt,createdAt,accessTokenEnc FROM link_item WHERE deleted=0 ORDER BY createdAt");
  return rows.map((r) => ({
    id: r.id as string, institutionId: (r.institutionId as string) ?? null, institution: (r.institution as string) ?? null,
    status: ((r.status as string) || "ok") as LinkItem["status"], lastError: (r.lastError as string) ?? null,
    lastSyncedAt: (r.lastSyncedAt as string) ?? null, createdAt: r.createdAt as string, hasToken: !!r.accessTokenEnc,
  }));
}
/** Items ever linked (including removed ones) — Plaid's Trial cap counts these for life. */
export async function lifetimeItemCount(): Promise<number> {
  const [{ n }] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM link_item");
  return n;
}
export async function listAccounts(): Promise<BankAccount[]> {
  const rows = await query("SELECT * FROM bank_account WHERE deleted=0 ORDER BY institution, name");
  return rows as unknown as BankAccount[];
}
const LIABILITY = new Set(["credit", "loan"]);
export function netWorth(accounts: BankAccount[]) {
  let assets = 0, liabilities = 0;
  for (const a of accounts) {
    const v = a.currentCents ?? 0;
    if (LIABILITY.has(a.type || "")) liabilities += v; else assets += v;
  }
  return { assets, liabilities, net: assets - liabilities };
}

// ---------- rules (merchant contains -> category), applied on import
export async function listRules(): Promise<CategoryRule[]> {
  const rows = await query("SELECT r.id, r.pattern, r.categoryId, c.name AS cname, c.icon AS cicon FROM category_rule r JOIN category c ON c.id=r.categoryId WHERE r.deleted=0 ORDER BY r.pattern");
  return rows.map((r) => ({ id: r.id as string, pattern: r.pattern as string, categoryId: r.categoryId as string, categoryName: r.cname as string, categoryIcon: (r.cicon as string) ?? null }));
}
export async function addRule(pattern: string, categoryId: string) {
  const p = pattern.trim();
  if (p.length < 2) throw new Error("Pattern needs at least 2 characters");
  if (!categoryId) throw new Error("Pick a category");
  const t = now();
  await query("INSERT INTO category_rule (id,pattern,categoryId,createdAt,updatedAt,deleted) VALUES (?,?,?,?,?,0)", [uid(), p, categoryId, t, t]);
  changed();
}
export async function deleteRule(id: string) {
  await query("UPDATE category_rule SET deleted=1, updatedAt=? WHERE id=?", [now(), id]);
  changed();
}
async function activeRules(): Promise<Rule[]> {
  return query<Rule>("SELECT pattern, categoryId FROM category_rule WHERE deleted=0");
}
/** Re-categorise existing bank transactions the user hasn't edited by hand. Returns the number changed. */
export async function applyRulesToExisting(): Promise<number> {
  const rules = await activeRules();
  const rows = await query<{ id: string; merchant: string; categoryId: string }>("SELECT id, merchant, categoryId FROM txn WHERE source='bank' AND deleted=0 AND userEdited=0");
  const t = now();
  const stmts: { sql: string; params: unknown[] }[] = [];
  for (const r of rows) {
    const hay = r.merchant.toLowerCase();
    let best: Rule | null = null;
    for (const rule of rules) { const p = rule.pattern.trim().toLowerCase(); if (p && hay.includes(p) && (!best || p.length > best.pattern.length)) best = rule; }
    if (best && best.categoryId !== r.categoryId) stmts.push({ sql: "UPDATE txn SET categoryId=?, updatedAt=? WHERE id=?", params: [best.categoryId, t, r.id] });
  }
  if (stmts.length) { await batch(stmts); changed(); }
  return stmts.length;
}

// ---------- Plaid Link (official hosted script)
type LinkMeta = { institution?: { name?: string; institution_id?: string } | null };
type PlaidHandler = { open: () => void; exit: (o?: unknown) => void; destroy: () => void };
type PlaidGlobal = { create: (c: {
  token: string; receivedRedirectUri?: string;
  onSuccess: (publicToken: string, meta: LinkMeta) => void;
  onExit: (err: { error_code?: string; error_message?: string; display_message?: string } | null, meta: unknown) => void;
}) => PlaidHandler };
declare global { interface Window { Plaid?: PlaidGlobal } }
let linkLoading: Promise<PlaidGlobal> | null = null;
function loadLink(): Promise<PlaidGlobal> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (!linkLoading) linkLoading = new Promise<PlaidGlobal>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LINK_JS; s.async = true;
    s.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid Link failed to load")));
    s.onerror = () => { linkLoading = null; reject(new Error("Couldn't load Plaid Link (offline or blocked?)")); };
    document.head.appendChild(s);
  });
  return linkLoading;
}
function runLink(token: string, receivedRedirectUri?: string): Promise<{ publicToken: string; meta: LinkMeta } | null> {
  return loadLink().then((Plaid) => new Promise((resolve, reject) => {
    const h = Plaid.create({
      token, receivedRedirectUri,
      onSuccess: (publicToken, meta) => { resolve({ publicToken, meta }); h.destroy(); },
      onExit: (err) => { h.destroy(); if (err) reject(new Error(err.display_message || err.error_message || err.error_code || "Bank linking failed")); else resolve(null); },
    });
    h.open();
  }));
}

type OAuthState = { token: string; mode: "new" | "update"; itemId?: string };
async function finishNew(publicToken: string, meta: LinkMeta): Promise<string> {
  const ex = await api<{ access_token: string; item_id: string }>("exchange", { public_token: publicToken });
  const t = now();
  await query(
    "INSERT INTO link_item (id,institutionId,institution,accessTokenEnc,cursor,status,lastError,lastSyncedAt,createdAt,updatedAt,deleted) VALUES (?,?,?,?,NULL,'ok',NULL,NULL,?,?,0) ON CONFLICT(id) DO UPDATE SET accessTokenEnc=excluded.accessTokenEnc, status='ok', lastError=NULL, deleted=0, updatedAt=excluded.updatedAt",
    [ex.item_id, meta.institution?.institution_id ?? null, meta.institution?.name ?? "Bank", await sealSecret(ex.access_token), t, t],
  );
  changed();
  return ex.item_id;
}
async function finishUpdate(itemId: string) {
  await query("UPDATE link_item SET status='ok', lastError=NULL, updatedAt=? WHERE id=?", [now(), itemId]);
  changed();
}

/** Link a new bank. Must be called from a user gesture. Returns the new item id, or null if cancelled. */
export async function linkNewBank(): Promise<string | null> {
  const { link_token } = await api<{ link_token: string }>("link-token", { client_user_id: clientUserId() });
  localStorage.setItem(LS_OAUTH, JSON.stringify({ token: link_token, mode: "new" } satisfies OAuthState));
  const r = await runLink(link_token);
  localStorage.removeItem(LS_OAUTH);
  if (!r) return null;
  const id = await finishNew(r.publicToken, r.meta);
  await syncItem(id);
  return id;
}
/** Re-authenticate an item (Plaid Link update mode), e.g. after ITEM_LOGIN_REQUIRED. */
export async function reconnectItem(itemId: string): Promise<boolean> {
  const token = await itemToken(itemId);
  const { link_token } = await api<{ link_token: string }>("link-token", { client_user_id: clientUserId(), access_token: token });
  localStorage.setItem(LS_OAUTH, JSON.stringify({ token: link_token, mode: "update", itemId } satisfies OAuthState));
  const r = await runLink(link_token);
  localStorage.removeItem(LS_OAUTH);
  if (!r) return false;
  await finishUpdate(itemId);
  await syncItem(itemId);
  return true;
}
/** Resume Link after an OAuth bank redirect (page /bank/oauth/). */
export async function resumeOAuth(): Promise<string> {
  let st: OAuthState | null = null;
  try { st = JSON.parse(localStorage.getItem(LS_OAUTH) || "null"); } catch {}
  if (!st?.token) throw new Error("No bank link in progress on this device.");
  const r = await runLink(st.token, window.location.href);
  localStorage.removeItem(LS_OAUTH);
  if (!r) return "Bank linking was cancelled.";
  if (st.mode === "update" && st.itemId) { await finishUpdate(st.itemId); await syncItem(st.itemId); return "Bank reconnected."; }
  const id = await finishNew(r.publicToken, r.meta);
  await syncItem(id);
  return "Bank linked.";
}

async function itemToken(itemId: string): Promise<string> {
  const [row] = await query<{ accessTokenEnc: string | null }>("SELECT accessTokenEnc FROM link_item WHERE id=? AND deleted=0", [itemId]);
  if (!row) throw new Error("Bank connection not found");
  const tok = await openSecret(row.accessTokenEnc);
  if (!tok) throw new Error("This device can't unlock the bank token — sync or restore a backup, or reconnect.");
  return tok;
}

// ---------- sync
type SyncResp = SyncPage & { next_cursor: string; has_more: boolean; accounts: PlaidAccount[] };
type PlaidAccount = { account_id: string; name: string; official_name: string | null; mask: string | null; type: string; subtype: string | null; balances: { current: number | null; available: number | null; iso_currency_code: string | null } };
const NEEDS_LOGIN = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ACCESS_NOT_GRANTED", "NO_ACCOUNTS"]);

async function ensureTransfersCategory() {
  await query("INSERT OR IGNORE INTO category (id,name,icon,color,isDefault,createdAt,updatedAt,deleted) VALUES ('default-transfers',?,'🔁','#64748b',1,?,'1970-01-01T00:00:00.000Z',0)", [TRANSFERS, now()]);
}

const running = new Map<string, Promise<{ added: number; modified: number; removed: number }>>();
export function syncItem(itemId: string) {
  const cur = running.get(itemId);
  if (cur) return cur;
  const p = doSync(itemId).finally(() => { running.delete(itemId); emit(); });
  running.set(itemId, p);
  emit();
  return p;
}
export const isSyncing = () => running.size > 0;

async function doSync(itemId: string) {
  const token = await itemToken(itemId);
  const [item] = await query<{ cursor: string | null; institution: string | null }>("SELECT cursor, institution FROM link_item WHERE id=?", [itemId]);
  try {
    // Fetch every page first, then apply atomically with the new cursor (Plaid's recommended pattern).
    let page: SyncPage = { added: [], modified: [], removed: [] };
    let cursor = item.cursor, accounts: PlaidAccount[] = [];
    for (let attempt = 0; ; attempt++) {
      page = { added: [], modified: [], removed: [] };
      cursor = item.cursor;
      try {
        for (let i = 0; i < 200; i++) {
          const r = await api<SyncResp>("transactions-sync", cursor ? { access_token: token, cursor } : { access_token: token });
          page.added.push(...r.added); page.modified.push(...r.modified); page.removed.push(...r.removed);
          if (r.accounts?.length) accounts = r.accounts;
          cursor = r.next_cursor;
          if (!r.has_more) break;
        }
        break;
      } catch (e) {
        if (e instanceof BankApiError && e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt < 3) continue;
        throw e;
      }
    }
    // Fresh balances (cached by Plaid, refreshed with transaction updates; no separately billed product).
    const acc = await api<{ accounts: PlaidAccount[] }>("accounts", { access_token: token });
    if (acc.accounts?.length) accounts = acc.accounts;

    await ensureTransfersCategory();
    const cats = await listCategories();
    const idByName = (n: string) => cats.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id ?? null;
    const rules = await activeRules();
    const existing = await query<{ id: string; externalId: string; userEdited: number; deleted: number }>("SELECT id, externalId, userEdited, deleted FROM txn WHERE externalId IS NOT NULL");
    const ops = planSync(page, existing, (t: PlaidTxn) => categoryFor(t, rules, idByName), uid);

    const t = now();
    const stmts: { sql: string; params?: unknown[] }[] = [];
    for (const o of ops) {
      if (o.op === "insert") {
        const r = o.row;
        stmts.push({ sql: "INSERT INTO txn (id,amountCents,date,merchant,categoryId,notes,source,createdAt,updatedAt,deleted,externalId,pending,accountId,userEdited) VALUES (?,?,?,?,?,NULL,'bank',?,?,0,?,?,?,0)", params: [r.id, r.amountCents, r.date, r.merchant, r.categoryId, t, t, r.externalId, r.pending, r.accountId] });
      } else if (o.op === "update") {
        const s = o.set;
        const cols = ["externalId=?", "accountId=?", "amountCents=?", "date=?", "pending=?"];
        const params: unknown[] = [s.externalId, s.accountId, s.amountCents, s.date, s.pending];
        if (s.merchant !== undefined) { cols.push("merchant=?"); params.push(s.merchant); }
        if (s.categoryId !== undefined) { cols.push("categoryId=?"); params.push(s.categoryId); }
        stmts.push({ sql: `UPDATE txn SET ${cols.join(", ")}, updatedAt=? WHERE id=?`, params: [...params, t, o.id] });
      } else {
        stmts.push({ sql: "UPDATE txn SET deleted=1, pending=0, updatedAt=? WHERE id=?", params: [t, o.id] });
      }
    }
    if (accounts.length) {
      const ids = accounts.map((a) => a.account_id);
      stmts.push({ sql: `UPDATE bank_account SET deleted=1, updatedAt=? WHERE itemId=? AND deleted=0 AND id NOT IN (${ids.map(() => "?").join(",")})`, params: [t, itemId, ...ids] });
      for (const a of accounts) stmts.push({
        sql: "INSERT INTO bank_account (id,itemId,institution,name,officialName,mask,type,subtype,currentCents,availableCents,currency,updatedAt,deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET itemId=excluded.itemId, institution=excluded.institution, name=excluded.name, officialName=excluded.officialName, mask=excluded.mask, type=excluded.type, subtype=excluded.subtype, currentCents=excluded.currentCents, availableCents=excluded.availableCents, currency=excluded.currency, updatedAt=excluded.updatedAt, deleted=0",
        params: [a.account_id, itemId, item.institution, a.name, a.official_name, a.mask, a.type, a.subtype, a.balances.current == null ? null : toCents(a.balances.current), a.balances.available == null ? null : toCents(a.balances.available), a.balances.iso_currency_code, t],
      });
    }
    stmts.push({ sql: "UPDATE link_item SET cursor=?, status='ok', lastError=NULL, lastSyncedAt=?, updatedAt=? WHERE id=?", params: [cursor, t, t, itemId] });
    await batch(stmts);
    changed();
    return { added: ops.filter((o) => o.op === "insert").length, modified: ops.filter((o) => o.op === "update").length, removed: ops.filter((o) => o.op === "tombstone").length };
  } catch (e) {
    if (e instanceof BankApiError && e.code && e.status !== 401 && e.status !== 429 && e.status !== 0) {
      const status = NEEDS_LOGIN.has(e.code) ? "login_required" : "error";
      await query("UPDATE link_item SET status=?, lastError=?, updatedAt=? WHERE id=?", [status, e.code, now(), itemId]);
      changed();
    }
    throw e;
  }
}

export async function syncAll(): Promise<{ ok: number; failed: number }> {
  const items = (await listItems()).filter((i) => i.hasToken);
  let ok = 0, failed = 0;
  for (const i of items) { try { await syncItem(i.id); ok++; } catch { failed++; } }
  localStorage.setItem(LS_AUTO, now());
  return { ok, failed };
}
/** Called on app open: sync at most once every AUTO_SYNC_HOURS, only when configured + key present. */
export async function autoSyncIfDue(): Promise<boolean> {
  if (!getApiKey() || !navigator.onLine) return false;
  const last = Date.parse(localStorage.getItem(LS_AUTO) || "");
  if (Number.isFinite(last) && Date.now() - last < AUTO_SYNC_HOURS * 3600_000) return false;
  const items = (await listItems()).filter((i) => i.hasToken && i.status === "ok");
  if (!items.length) return false;
  const st = await getBankStatus();
  if (!st.configured) return false;
  await syncAll();
  return true;
}

/** Revoke at Plaid and forget locally. Transactions already imported are kept. Doesn't free a Trial slot. */
export async function removeItem(itemId: string) {
  let token: string | null = null;
  try { token = await itemToken(itemId); } catch {}
  if (token) {
    try { await api("item-remove", { access_token: token }); }
    catch (e) {
      // Already gone at Plaid (or token invalid) => fine to forget locally. Anything else: keep it so we can retry.
      if (!(e instanceof BankApiError && (e.code === "ITEM_NOT_FOUND" || e.code === "INVALID_ACCESS_TOKEN"))) throw e;
    }
  }
  const t = now();
  await batch([
    { sql: "UPDATE link_item SET deleted=1, accessTokenEnc=NULL, cursor=NULL, updatedAt=? WHERE id=?", params: [t, itemId] },
    { sql: "UPDATE bank_account SET deleted=1, updatedAt=? WHERE itemId=?", params: [t, itemId] },
  ]);
  changed();
}

/** Dev/test-only introspection hook, enabled with localStorage['openmint.debug']='1'. */
export function installDebugHook() {
  if (localStorage.getItem("openmint.debug") === "1") (window as unknown as { __openMint: unknown }).__openMint = { query };
}
