// Local-first storage worker: SQLite WASM persisted in the Origin Private File System
// (opfs-sahpool VFS, no COOP/COEP headers needed). Runs entirely in the browser.
import sqlite3InitModule from "/sqlite/index.mjs";

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS category (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT,
  isDefault INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  id TEXT PRIMARY KEY, categoryId TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  month TEXT NOT NULL, amountCents INTEGER NOT NULL, UNIQUE(categoryId, month)
);
CREATE TABLE IF NOT EXISTS txn (
  id TEXT PRIMARY KEY, amountCents INTEGER NOT NULL, date TEXT NOT NULL, merchant TEXT NOT NULL,
  categoryId TEXT NOT NULL REFERENCES category(id) ON DELETE RESTRICT,
  notes TEXT, source TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS txn_date ON txn(date);
`;

const DEFAULTS = [
  ["Groceries", "🛒", "#22c55e"], ["Dining", "🍽️", "#f97316"], ["Transport", "🚗", "#3b82f6"],
  ["Housing", "🏠", "#8b5cf6"], ["Utilities", "💡", "#eab308"], ["Entertainment", "🎬", "#ec4899"],
  ["Health", "❤️", "#ef4444"], ["Shopping", "🛍️", "#14b8a6"], ["Income", "💰", "#10b981"],
  ["Other", "📦", "#6b7280"],
];

let db;
let storage = "unknown";

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "mint-local" });
    db = new pool.OpfsSAHPoolDb("/mint.sqlite3");
    storage = "opfs";
  } catch (e) {
    // Most likely: another tab holds the OPFS lock, or OPFS unsupported.
    throw new Error("Could not open on-device database (is the app open in another tab?): " + (e && e.message));
  }
  db.exec(SCHEMA);
  const n = db.selectValue("SELECT COUNT(*) FROM category");
  if (!n) {
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const [name, icon, color] of DEFAULTS) {
        db.exec({ sql: "INSERT INTO category (id,name,icon,color,isDefault,createdAt) VALUES (?,?,?,?,1,?)",
          bind: [crypto.randomUUID(), name, icon, color, now] });
      }
    });
  }
})();

function run(sql, params) {
  const rows = [];
  db.exec({ sql, bind: params && params.length ? params : undefined, rowMode: "object", resultRows: rows });
  return rows;
}

self.onmessage = async (ev) => {
  const { id, op, sql, params, stmts } = ev.data;
  try {
    await ready;
    let result;
    if (op === "query") result = run(sql, params);
    else if (op === "batch") {
      result = [];
      db.transaction(() => { for (const s of stmts) result.push(run(s.sql, s.params)); });
    } else if (op === "info") result = { storage };
    else throw new Error("unknown op " + op);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
