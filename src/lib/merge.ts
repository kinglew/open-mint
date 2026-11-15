// Pure, deterministic merge of two snapshots (no I/O) — unit-tested in scripts/test-merge.mjs.
// Rules:
//  * Every record is merged by id with last-writer-wins on updatedAt; ties broken deterministically.
//  * Deletes are tombstones (deleted=1) so they win over older edits on other devices.
//  * Default categories created independently on two devices (same name, different ids) are
//    collapsed onto one canonical id (smallest id), and references are rewritten.
//  * Budgets are unique per (category, month): newest wins, others are dropped.
//  * Bank transactions are unique per externalId (Plaid transaction_id): if two devices imported the same
//    bank transaction under different local ids, one canonical row is kept (live > user-edited > newest >
//    smallest id) and the duplicate becomes a tombstone with externalId cleared.
//  * Bank accounts, link items and category rules merge by id (LWW + tombstones).
import type { Snapshot } from "./db";

type Row = Record<string, unknown>;
const ts = (r: Row) => (r.updatedAt as string) || (r.createdAt as string) || "";

function newer(a: Row, b: Row): Row {
  const ta = ts(a), tb = ts(b);
  if (ta !== tb) return ta > tb ? a : b;
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b; // tie: delete wins
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function lww(a: Row[], b: Row[]): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of [...a, ...b]) {
    const id = r.id as string;
    const cur = m.get(id);
    m.set(id, cur ? newer(cur, r) : { ...r });
  }
  return m;
}

export function mergeSnapshots(local: Snapshot, remote: Snapshot | null, now = new Date().toISOString()): Snapshot {
  if (!remote) remote = { version: 1, exportedAt: now, categories: [], budgets: [], transactions: [] };
  const cats = lww(local.categories, remote.categories);

  // Collapse duplicate default categories by name.
  const remap = new Map<string, string>();
  const byName = new Map<string, Row[]>();
  for (const c of cats.values()) {
    if (!c.isDefault) continue;
    const k = String(c.name).trim().toLowerCase();
    byName.set(k, [...(byName.get(k) || []), c]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    group.sort((x, y) => String(x.id).localeCompare(String(y.id)));
    const canon = group[0];
    const anyLive = group.some((g) => !g.deleted);
    if (anyLive && canon.deleted) cats.set(canon.id as string, { ...canon, deleted: 0 });
    for (const dup of group.slice(1)) {
      remap.set(dup.id as string, canon.id as string);
      if (!dup.deleted) cats.set(dup.id as string, { ...dup, deleted: 1 });
    }
  }
  const fix = (r: Row) => (remap.has(r.categoryId as string) ? { ...r, categoryId: remap.get(r.categoryId as string) } : r);

  const txns = dedupeExternal([...lww(local.transactions, remote.transactions).values()].map(fix));

  const budgetsById = [...lww(local.budgets, remote.budgets).values()].map(fix);
  const byKey = new Map<string, Row>();
  for (const b of budgetsById) {
    const k = `${b.categoryId}|${b.month}`;
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, b); continue; }
    // Prefer a live budget over a tombstone, then newest, then smallest id.
    let win: Row;
    if (!!cur.deleted !== !!b.deleted) win = cur.deleted ? b : cur;
    else if (ts(cur) !== ts(b)) win = ts(cur) > ts(b) ? cur : b;
    else win = String(cur.id) < String(b.id) ? cur : b;
    byKey.set(k, win);
  }

  const sortId = (a: Row, b: Row) => String(a.id).localeCompare(String(b.id));
  return {
    version: 1,
    exportedAt: now,
    categories: [...cats.values()].sort(sortId),
    budgets: [...byKey.values()].sort(sortId),
    transactions: txns.sort(sortId),
    accounts: [...lww(local.accounts || [], remote.accounts || []).values()].sort(sortId),
    linkItems: mergeItems(local.linkItems || [], remote.linkItems || []).sort(sortId),
    rules: [...lww(local.rules || [], remote.rules || []).values()].map(fix).sort(sortId),
  };
}

function dedupeExternal(txns: Row[]): Row[] {
  const byExt = new Map<string, Row[]>();
  for (const t of txns) if (t.externalId) byExt.set(t.externalId as string, [...(byExt.get(t.externalId as string) || []), t]);
  const losers = new Map<string, Row>();
  for (const group of byExt.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) =>
      (Number(!!a.deleted) - Number(!!b.deleted)) ||
      (Number(!!b.userEdited) - Number(!!a.userEdited)) ||
      (ts(a) !== ts(b) ? (ts(a) > ts(b) ? -1 : 1) : 0) ||
      String(a.id).localeCompare(String(b.id)));
    for (const l of group.slice(1)) losers.set(l.id as string, { ...l, deleted: 1, externalId: null });
  }
  return txns.map((t) => losers.get(t.id as string) || t);
}

// Link items: LWW, but never let a copy that couldn't decrypt its token (null) erase a live token.
function mergeItems(a: Row[], b: Row[]): Row[] {
  const tokens = new Map<string, unknown>();
  for (const r of [...a, ...b]) if (r.accessToken) tokens.set(r.id as string, r.accessToken);
  return [...lww(a, b).values()].map((r) => (!r.deleted && !r.accessToken && tokens.has(r.id as string) ? { ...r, accessToken: tokens.get(r.id as string) } : r));
}
