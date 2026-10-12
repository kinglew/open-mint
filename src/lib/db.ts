"use client";
// Client-only data layer. All reads/writes go to SQLite WASM in a Web Worker,
// persisted in the browser's Origin Private File System. No network calls.
import { currentMonth } from "./format";

export type Category = { id: string; name: string; icon: string | null; color: string | null; isDefault: boolean; createdAt: string };
export type Budget = { id: string; categoryId: string; month: string; amountCents: number; category: Category };
export type Txn = {
  id: string; amountCents: number; date: string; merchant: string; categoryId: string;
  notes: string | null; source: "manual" | "ocr"; createdAt: string; updatedAt: string | null; category: Category;
};
export type TxnInput = { amountCents: number; date: string; merchant: string; categoryId: string; notes: string | null; source: "manual" | "ocr" };

type Row = Record<string, unknown>;
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (typeof window === "undefined") throw new Error("DB is browser-only");
  if (!worker) {
    worker = new Worker("/db-worker.mjs", { type: "module" });
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
  }
  return worker;
}

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, ...msg });
  });
}

export const query = <T = Row>(sql: string, params: unknown[] = []) => call<T[]>({ op: "query", sql, params });
export const batch = (stmts: { sql: string; params?: unknown[] }[]) => call<Row[][]>({ op: "batch", stmts });

// Notify listeners (e.g. the sync agent) that local data changed.
export const LOCAL_CHANGE_EVENT = "openmint:local-change";
export const DATA_SYNCED_EVENT = "openmint:data-synced";
function changed() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT));
}
async function write<T>(p: Promise<T>): Promise<T> { const r = await p; changed(); return r; }
export const storageInfo = () => call<{ storage: string; schemaVersion: number }>({ op: "info" });

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function toCategory(r: Row): Category {
  return { id: r.id as string, name: r.name as string, icon: (r.icon as string) ?? null, color: (r.color as string) ?? null, isDefault: !!r.isDefault, createdAt: r.createdAt as string };
}
const CAT_COLS = "c.id AS c_id, c.name AS c_name, c.icon AS c_icon, c.color AS c_color, c.isDefault AS c_isDefault, c.createdAt AS c_createdAt";
function catFromJoined(r: Row): Category {
  return toCategory({ id: r.c_id, name: r.c_name, icon: r.c_icon, color: r.c_color, isDefault: r.c_isDefault, createdAt: r.c_createdAt });
}
function toTxn(r: Row): Txn {
  return { id: r.id as string, amountCents: r.amountCents as number, date: r.date as string, merchant: r.merchant as string, categoryId: r.categoryId as string, notes: (r.notes as string) ?? null, source: r.source as "manual" | "ocr", createdAt: r.createdAt as string, updatedAt: (r.updatedAt as string) ?? null, category: catFromJoined(r) };
}

// ---- Categories
export async function listCategories(): Promise<Category[]> {
  return (await query("SELECT * FROM category WHERE deleted=0 ORDER BY isDefault DESC, name ASC")).map(toCategory);
}
export async function addCategory(name: string, icon = "🏷️", color = "#6b7280") {
  const n = name.trim();
  if (!n) throw new Error("Name is required");
  const t = now();
  await write(query("INSERT INTO category (id,name,icon,color,isDefault,createdAt,updatedAt,deleted) VALUES (?,?,?,?,0,?,?,0)", [uid(), n, icon || "🏷️", color, t, t]));
}
export async function deleteCategory(id: string) {
  const [c] = await query("SELECT isDefault FROM category WHERE id=? AND deleted=0", [id]);
  if (!c) throw new Error("Not found");
  if (c.isDefault) throw new Error("Cannot delete default categories");
  const [{ n }] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM txn WHERE categoryId=? AND deleted=0", [id]);
  if (n > 0) throw new Error("Category has transactions; reassign them first");
  const t = now();
  await write(batch([{ sql: "UPDATE budget SET deleted=1, updatedAt=? WHERE categoryId=? AND deleted=0", params: [t, id] }, { sql: "UPDATE category SET deleted=1, updatedAt=? WHERE id=?", params: [t, id] }]));
}

// ---- Transactions
function validate(t: TxnInput) {
  if (!Number.isFinite(t.amountCents) || t.amountCents === 0) throw new Error("Amount is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error("Invalid date");
  if (!t.merchant.trim()) throw new Error("Merchant is required");
  if (!t.categoryId) throw new Error("Category is required");
}
export async function listTxns(month?: string): Promise<Txn[]> {
  const where = month ? "WHERE t.deleted=0 AND t.date LIKE ?" : "WHERE t.deleted=0";
  const rows = await query(`SELECT t.*, ${CAT_COLS} FROM txn t JOIN category c ON c.id=t.categoryId ${where} ORDER BY t.date DESC, t.createdAt DESC`, month ? [month + "%"] : []);
  return rows.map(toTxn);
}
export async function getTxn(id: string): Promise<Txn | null> {
  const rows = await query(`SELECT t.*, ${CAT_COLS} FROM txn t JOIN category c ON c.id=t.categoryId WHERE t.id=? AND t.deleted=0`, [id]);
  return rows[0] ? toTxn(rows[0]) : null;
}
export async function addTxn(t: TxnInput) {
  validate(t);
  const ts = now();
  await write(query("INSERT INTO txn (id,amountCents,date,merchant,categoryId,notes,source,createdAt,updatedAt,deleted) VALUES (?,?,?,?,?,?,?,?,?,0)",
    [uid(), Math.round(t.amountCents), t.date, t.merchant.trim(), t.categoryId, t.notes, t.source === "ocr" ? "ocr" : "manual", ts, ts]));
}
export async function updateTxn(id: string, t: TxnInput) {
  validate(t);
  await write(query("UPDATE txn SET amountCents=?, date=?, merchant=?, categoryId=?, notes=?, updatedAt=? WHERE id=?",
    [Math.round(t.amountCents), t.date, t.merchant.trim(), t.categoryId, t.notes, now(), id]));
}
export async function deleteTxn(id: string) {
  await write(query("UPDATE txn SET deleted=1, updatedAt=? WHERE id=?", [now(), id]));
}

// ---- Budgets
export async function listBudgets(month = currentMonth()): Promise<Budget[]> {
  const rows = await query(`SELECT b.*, ${CAT_COLS} FROM budget b JOIN category c ON c.id=b.categoryId WHERE b.month=? AND b.deleted=0 ORDER BY c.name`, [month]);
  return rows.map((r) => ({ id: r.id as string, categoryId: r.categoryId as string, month: r.month as string, amountCents: r.amountCents as number, category: catFromJoined(r) }));
}
export async function setBudget(categoryId: string, month: string, amountCents: number) {
  if (!categoryId || !Number.isFinite(amountCents) || amountCents < 0) throw new Error("Invalid budget");
  await write(query("INSERT INTO budget (id,categoryId,month,amountCents,updatedAt,deleted) VALUES (?,?,?,?,?,0) ON CONFLICT(categoryId,month) DO UPDATE SET amountCents=excluded.amountCents, updatedAt=excluded.updatedAt, deleted=0",
    [uid(), categoryId, month, Math.round(amountCents), now()]));
}

export function isIncome(t: Txn) {
  return t.category.name.toLowerCase() === "income" || t.amountCents < 0;
}

// ---- Snapshot (for backup + sync). Includes tombstones (deleted=1) so deletes propagate.
export type Snapshot = { version: 1; exportedAt: string; categories: Row[]; budgets: Row[]; transactions: Row[] };
export async function exportSnapshot(): Promise<Snapshot> {
  const [categories, budgets, transactions] = await batch([
    { sql: "SELECT id,name,icon,color,isDefault,createdAt,updatedAt,deleted FROM category" },
    { sql: "SELECT id,categoryId,month,amountCents,updatedAt,deleted FROM budget" },
    { sql: "SELECT id,amountCents,date,merchant,categoryId,notes,source,createdAt,updatedAt,deleted FROM txn" },
  ]);
  return { version: 1, exportedAt: now(), categories, budgets, transactions };
}
const live = (r: Row) => !r.deleted;
export function liveCounts(s: Snapshot) {
  return { txns: s.transactions.filter(live).length, budgets: s.budgets.filter(live).length, categories: s.categories.filter(live).length };
}
const ts0 = (r: Row, fallback: unknown) => (r.updatedAt as string) || (fallback as string) || "1970-01-01T00:00:00.000Z";
function upsertStmts(s: Snapshot, onlyIfNewer: boolean) {
  const guard = (t: string) => (onlyIfNewer ? ` WHERE excluded.updatedAt >= ${t}.updatedAt OR ${t}.updatedAt IS NULL` : "");
  const stmts: { sql: string; params?: unknown[] }[] = [];
  for (const c of s.categories) stmts.push({ sql: `INSERT INTO category (id,name,icon,color,isDefault,createdAt,updatedAt,deleted) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, color=excluded.color, isDefault=excluded.isDefault, updatedAt=excluded.updatedAt, deleted=excluded.deleted${guard("category")}`, params: [c.id, c.name, c.icon, c.color, c.isDefault ? 1 : 0, c.createdAt, ts0(c, c.createdAt), c.deleted ? 1 : 0] });
  for (const b of s.budgets) stmts.push({ sql: `INSERT INTO budget (id,categoryId,month,amountCents,updatedAt,deleted) VALUES (?,?,?,?,?,?) ON CONFLICT DO UPDATE SET amountCents=excluded.amountCents, updatedAt=excluded.updatedAt, deleted=excluded.deleted${guard("budget")}`, params: [b.id, b.categoryId, b.month, b.amountCents, ts0(b, s.exportedAt), b.deleted ? 1 : 0] });
  for (const t of s.transactions) stmts.push({ sql: `INSERT INTO txn (id,amountCents,date,merchant,categoryId,notes,source,createdAt,updatedAt,deleted) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET amountCents=excluded.amountCents, date=excluded.date, merchant=excluded.merchant, categoryId=excluded.categoryId, notes=excluded.notes, source=excluded.source, updatedAt=excluded.updatedAt, deleted=excluded.deleted${guard("txn")}`, params: [t.id, t.amountCents, t.date, t.merchant, t.categoryId, t.notes, t.source, t.createdAt, ts0(t, t.createdAt), t.deleted ? 1 : 0] });
  return stmts;
}
export async function importSnapshot(s: Snapshot, mode: "replace" | "merge") {
  if (s.version !== 1) throw new Error("Unsupported backup version");
  const stmts: { sql: string; params?: unknown[] }[] = [];
  if (mode === "replace") stmts.push({ sql: "DELETE FROM txn" }, { sql: "DELETE FROM budget" }, { sql: "DELETE FROM category" });
  stmts.push(...upsertStmts(s, false));
  stmts.push({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES ('lastImport',?)", params: [now()] });
  await write(batch(stmts));
}
/** Apply a merged sync snapshot. Rows are only overwritten if the merged copy is at least as new,
 *  so an edit made on this device while a sync was in flight is never lost. Budget rows that lost a
 *  (category, month) de-duplication are removed. */
export async function applySyncedSnapshot(merged: Snapshot) {
  const stmts: { sql: string; params?: unknown[] }[] = [];
  for (const b of merged.budgets) stmts.push({ sql: "DELETE FROM budget WHERE categoryId=? AND month=? AND id<>?", params: [b.categoryId, b.month, b.id] });
  stmts.push(...upsertStmts(merged, true));
  await batch(stmts);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DATA_SYNCED_EVENT));
}
export async function getMeta(key: string): Promise<string | null> {
  const r = await query<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]);
  return r[0]?.value ?? null;
}
export async function setMeta(key: string, value: string) {
  await query("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", [key, value]);
}
