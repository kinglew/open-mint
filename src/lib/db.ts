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
export const storageInfo = () => call<{ storage: string }>({ op: "info" });

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
  return (await query("SELECT * FROM category ORDER BY isDefault DESC, name ASC")).map(toCategory);
}
export async function addCategory(name: string, icon = "🏷️", color = "#6b7280") {
  const n = name.trim();
  if (!n) throw new Error("Name is required");
  await query("INSERT INTO category (id,name,icon,color,isDefault,createdAt) VALUES (?,?,?,?,0,?)", [uid(), n, icon || "🏷️", color, now()]);
}
export async function deleteCategory(id: string) {
  const [c] = await query("SELECT isDefault FROM category WHERE id=?", [id]);
  if (!c) throw new Error("Not found");
  if (c.isDefault) throw new Error("Cannot delete default categories");
  const [{ n }] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM txn WHERE categoryId=?", [id]);
  if (n > 0) throw new Error("Category has transactions; reassign them first");
  await batch([{ sql: "DELETE FROM budget WHERE categoryId=?", params: [id] }, { sql: "DELETE FROM category WHERE id=?", params: [id] }]);
}

// ---- Transactions
function validate(t: TxnInput) {
  if (!Number.isFinite(t.amountCents) || t.amountCents === 0) throw new Error("Amount is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error("Invalid date");
  if (!t.merchant.trim()) throw new Error("Merchant is required");
  if (!t.categoryId) throw new Error("Category is required");
}
export async function listTxns(month?: string): Promise<Txn[]> {
  const where = month ? "WHERE t.date LIKE ?" : "";
  const rows = await query(`SELECT t.*, ${CAT_COLS} FROM txn t JOIN category c ON c.id=t.categoryId ${where} ORDER BY t.date DESC, t.createdAt DESC`, month ? [month + "%"] : []);
  return rows.map(toTxn);
}
export async function getTxn(id: string): Promise<Txn | null> {
  const rows = await query(`SELECT t.*, ${CAT_COLS} FROM txn t JOIN category c ON c.id=t.categoryId WHERE t.id=?`, [id]);
  return rows[0] ? toTxn(rows[0]) : null;
}
export async function addTxn(t: TxnInput) {
  validate(t);
  await query("INSERT INTO txn (id,amountCents,date,merchant,categoryId,notes,source,createdAt) VALUES (?,?,?,?,?,?,?,?)",
    [uid(), Math.round(t.amountCents), t.date, t.merchant.trim(), t.categoryId, t.notes, t.source === "ocr" ? "ocr" : "manual", now()]);
}
export async function updateTxn(id: string, t: TxnInput) {
  validate(t);
  await query("UPDATE txn SET amountCents=?, date=?, merchant=?, categoryId=?, notes=?, updatedAt=? WHERE id=?",
    [Math.round(t.amountCents), t.date, t.merchant.trim(), t.categoryId, t.notes, now(), id]);
}
export async function deleteTxn(id: string) {
  await query("DELETE FROM txn WHERE id=?", [id]);
}

// ---- Budgets
export async function listBudgets(month = currentMonth()): Promise<Budget[]> {
  const rows = await query(`SELECT b.*, ${CAT_COLS} FROM budget b JOIN category c ON c.id=b.categoryId WHERE b.month=? ORDER BY c.name`, [month]);
  return rows.map((r) => ({ id: r.id as string, categoryId: r.categoryId as string, month: r.month as string, amountCents: r.amountCents as number, category: catFromJoined(r) }));
}
export async function setBudget(categoryId: string, month: string, amountCents: number) {
  if (!categoryId || !Number.isFinite(amountCents) || amountCents < 0) throw new Error("Invalid budget");
  await query("INSERT INTO budget (id,categoryId,month,amountCents) VALUES (?,?,?,?) ON CONFLICT(categoryId,month) DO UPDATE SET amountCents=excluded.amountCents",
    [uid(), categoryId, month, Math.round(amountCents)]);
}

export function isIncome(t: Txn) {
  return t.category.name.toLowerCase() === "income" || t.amountCents < 0;
}

// ---- Snapshot (for backup)
export type Snapshot = { version: 1; exportedAt: string; categories: Row[]; budgets: Row[]; transactions: Row[] };
export async function exportSnapshot(): Promise<Snapshot> {
  const [categories, budgets, transactions] = await batch([
    { sql: "SELECT * FROM category" }, { sql: "SELECT * FROM budget" }, { sql: "SELECT * FROM txn" },
  ]);
  return { version: 1, exportedAt: now(), categories, budgets, transactions };
}
export async function importSnapshot(s: Snapshot, mode: "replace" | "merge") {
  if (s.version !== 1) throw new Error("Unsupported backup version");
  const verb = mode === "replace" ? "INSERT" : "INSERT OR REPLACE";
  const stmts: { sql: string; params?: unknown[] }[] = [];
  if (mode === "replace") stmts.push({ sql: "DELETE FROM txn" }, { sql: "DELETE FROM budget" }, { sql: "DELETE FROM category" });
  for (const c of s.categories) stmts.push({ sql: `${verb} INTO category (id,name,icon,color,isDefault,createdAt) VALUES (?,?,?,?,?,?)`, params: [c.id, c.name, c.icon, c.color, c.isDefault ? 1 : 0, c.createdAt] });
  // merge: same category+month budget from backup wins
  for (const b of s.budgets) stmts.push({ sql: "INSERT INTO budget (id,categoryId,month,amountCents) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET amountCents=excluded.amountCents", params: [b.id, b.categoryId, b.month, b.amountCents] });
  for (const t of s.transactions) stmts.push({ sql: `${verb} INTO txn (id,amountCents,date,merchant,categoryId,notes,source,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`, params: [t.id, t.amountCents, t.date, t.merchant, t.categoryId, t.notes, t.source, t.createdAt, t.updatedAt ?? null] });
  stmts.push({ sql: "INSERT OR REPLACE INTO meta (key,value) VALUES ('lastImport',?)", params: [now()] });
  await batch(stmts);
}
export async function getMeta(key: string): Promise<string | null> {
  const r = await query<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]);
  return r[0]?.value ?? null;
}
export async function setMeta(key: string, value: string) {
  await query("INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)", [key, value]);
}
