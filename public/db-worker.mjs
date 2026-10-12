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

// Versioned schema migrations. Each runs once, inside a transaction.
const MIGRATIONS = [
  // v1: sync support — per-record updatedAt (last-writer-wins) + tombstones for deletes.
  (db) => {
    const ts = new Date().toISOString();
    db.exec(`
      ALTER TABLE category ADD COLUMN updatedAt TEXT;
      ALTER TABLE category ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE budget ADD COLUMN updatedAt TEXT;
      ALTER TABLE budget ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE txn ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
    `);
    db.exec({ sql: "UPDATE category SET updatedAt = CASE WHEN isDefault=1 THEN '1970-01-01T00:00:00.000Z' ELSE createdAt END WHERE updatedAt IS NULL" });
    db.exec({ sql: "UPDATE budget SET updatedAt = ? WHERE updatedAt IS NULL", bind: [ts] });
    db.exec({ sql: "UPDATE txn SET updatedAt = createdAt WHERE updatedAt IS NULL" });
  },
];

function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)");
  const cur = db.selectValue("SELECT COALESCE(MAX(version),0) FROM schema_migrations");
  for (let v = cur + 1; v <= MIGRATIONS.length; v++) {
    db.transaction((t) => {
      MIGRATIONS[v - 1](t);
      t.exec({ sql: "INSERT INTO schema_migrations (version, appliedAt) VALUES (?,?)", bind: [v, new Date().toISOString()] });
    });
  }
}

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
  migrate();
  const n = db.selectValue("SELECT COUNT(*) FROM category");
  if (!n) {
    const now = new Date().toISOString();
    db.transaction(() => {
      for (const [name, icon, color] of DEFAULTS) {
        // Deterministic ids so independently-created devices agree on default categories.
        db.exec({ sql: "INSERT INTO category (id,name,icon,color,isDefault,createdAt,updatedAt,deleted) VALUES (?,?,?,?,1,?,?,0)",
          bind: ["default-" + name.toLowerCase(), name, icon, color, now, "1970-01-01T00:00:00.000Z"] });
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
    } else if (op === "info") result = { storage, schemaVersion: db.selectValue("SELECT MAX(version) FROM schema_migrations") };
    else throw new Error("unknown op " + op);
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
};
