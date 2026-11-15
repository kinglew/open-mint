// Unit tests for sync merge + encryption. Compiles src/lib/{merge,backup}.ts with tsc, runs with node:test.
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "om-unit-"));
execSync(`npx tsc src/lib/merge.ts src/lib/backup.ts src/lib/plaid-map.ts --outDir ${out} --module es2022 --target es2022 --moduleResolution bundler --skipLibCheck --lib es2022,dom`, { stdio: "inherit" });
writeFileSync(join(out, "package.json"), '{"type":"module"}');
const { mergeSnapshots } = await import(join(out, "merge.js"));
const { deriveKey, sealJSON, openJSON } = await import(join(out, "backup.js"));
const { mapPfc, matchRule, categoryFor, planSync, merchantOf } = await import(join(out, "plaid-map.js"));

const snap = (o = {}) => ({ version: 1, exportedAt: "x", categories: [], budgets: [], transactions: [], ...o });
const cat = (id, name, extra = {}) => ({ id, name, icon: null, color: null, isDefault: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", deleted: 0, ...extra });
const tx = (id, merchant, updatedAt, extra = {}) => ({ id, amountCents: 100, date: "2026-10-01", merchant, categoryId: "c1", notes: null, source: "manual", createdAt: "2026-10-01T00:00:00Z", updatedAt, deleted: 0, ...extra });

test("union of disjoint records", () => {
  const m = mergeSnapshots(snap({ categories: [cat("c1", "A")], transactions: [tx("t1", "A", "2026-10-01T01:00:00Z")] }),
    snap({ transactions: [tx("t2", "B", "2026-10-01T02:00:00Z")] }));
  assert.deepEqual(m.transactions.map((t) => t.id), ["t1", "t2"]);
});
test("last writer wins per record", () => {
  const m = mergeSnapshots(snap({ transactions: [tx("t1", "old", "2026-10-01T01:00:00Z")] }), snap({ transactions: [tx("t1", "new", "2026-10-02T00:00:00Z")] }));
  assert.equal(m.transactions[0].merchant, "new");
  const m2 = mergeSnapshots(snap({ transactions: [tx("t1", "local-newer", "2026-10-03T00:00:00Z")] }), snap({ transactions: [tx("t1", "remote", "2026-10-02T00:00:00Z")] }));
  assert.equal(m2.transactions[0].merchant, "local-newer");
});
test("tombstone beats older edit; newer edit beats older tombstone; tie -> delete", () => {
  let m = mergeSnapshots(snap({ transactions: [tx("t1", "e", "2026-10-01T00:00:00Z")] }), snap({ transactions: [tx("t1", "e", "2026-10-02T00:00:00Z", { deleted: 1 })] }));
  assert.equal(m.transactions[0].deleted, 1);
  m = mergeSnapshots(snap({ transactions: [tx("t1", "e", "2026-10-03T00:00:00Z")] }), snap({ transactions: [tx("t1", "e", "2026-10-02T00:00:00Z", { deleted: 1 })] }));
  assert.equal(m.transactions[0].deleted, 0);
  m = mergeSnapshots(snap({ transactions: [tx("t1", "e", "T")] }), snap({ transactions: [tx("t1", "e", "T", { deleted: 1 })] }));
  assert.equal(m.transactions[0].deleted, 1);
});
test("merge is commutative and idempotent", () => {
  const a = snap({ categories: [cat("c1", "A")], transactions: [tx("t1", "a", "2026-10-01T00:00:00Z"), tx("t2", "x", "2026-10-05T00:00:00Z")] });
  const b = snap({ transactions: [tx("t2", "y", "2026-10-04T00:00:00Z"), tx("t3", "b", "2026-10-02T00:00:00Z", { deleted: 1 })] });
  const ab = mergeSnapshots(a, b, "N"), ba = mergeSnapshots(b, a, "N");
  assert.deepEqual(ab, ba);
  assert.deepEqual(mergeSnapshots(ab, ab, "N"), ab);
});
test("duplicate default categories collapse to one id and references are rewritten", () => {
  const a = snap({ categories: [cat("aaa", "Groceries", { isDefault: 1 })], transactions: [tx("t1", "x", "T", { categoryId: "aaa" })], budgets: [{ id: "b1", categoryId: "aaa", month: "2026-10", amountCents: 1, updatedAt: "2026-10-01", deleted: 0 }] });
  const b = snap({ categories: [cat("zzz", "Groceries", { isDefault: 1 })], transactions: [tx("t2", "y", "T", { categoryId: "zzz" })], budgets: [{ id: "b2", categoryId: "zzz", month: "2026-10", amountCents: 2, updatedAt: "2026-10-02", deleted: 0 }] });
  const m = mergeSnapshots(a, b);
  assert.deepEqual(m.categories.filter((c) => !c.deleted).map((c) => c.id), ["aaa"]);
  assert.ok(m.transactions.every((t) => t.categoryId === "aaa"));
  assert.equal(m.budgets.length, 1);
  assert.equal(m.budgets[0].amountCents, 2, "newest budget for (category, month) wins");
});
test("AES-GCM seal/open round-trip; wrong passphrase fails; ciphertext hides plaintext", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await deriveKey("correct horse battery", salt, 1000);
  const sealed = await sealJSON(k, { merchant: "Loblaws" });
  assert.ok(!atob(sealed.ct).includes("Loblaws"));
  assert.deepEqual(await openJSON(k, sealed.iv, sealed.ct), { merchant: "Loblaws" });
  const bad = await deriveKey("wrong pass", salt, 1000);
  await assert.rejects(openJSON(bad, sealed.iv, sealed.ct));
});

// ---------------- bank import (Plaid) ----------------
const ptx = (id, extra = {}) => ({ transaction_id: id, account_id: "acc1", amount: 12.34, date: "2026-11-01", name: "STARBUCKS #123", merchant_name: "Starbucks", pending: false, pending_transaction_id: null, personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }, ...extra });
let n = 0; const newId = () => "L" + (++n);
const catById = (name) => "id-" + name.toLowerCase();
const catFor = (t) => categoryFor(t, [], catById);

test("PFC mapping table: detailed overrides, primaries, fallback", () => {
  assert.equal(mapPfc({ primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" }), "Groceries");
  assert.equal(mapPfc({ primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" }), "Dining");
  assert.equal(mapPfc({ primary: "INCOME", detailed: "INCOME_WAGES" }), "Income");
  assert.equal(mapPfc({ primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }), "Transfers");
  assert.equal(mapPfc({ primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" }), "Housing");
  assert.equal(mapPfc({ primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" }), "Utilities");
  assert.equal(mapPfc({ primary: "SOMETHING_NEW" }), "Other");
  assert.equal(mapPfc(null), "Other");
});
test("user rules beat the mapping table; longest pattern wins; unknown category falls back to Other", () => {
  const rules = [{ pattern: "star", categoryId: "id-entertainment" }, { pattern: "starbucks", categoryId: "id-groceries" }];
  assert.equal(matchRule(ptx("a"), rules), "id-groceries");
  assert.equal(categoryFor(ptx("a"), rules, catById), "id-groceries");
  assert.equal(categoryFor(ptx("a", { name: "X", merchant_name: "Y" }), rules, catById), "id-dining");
  assert.equal(categoryFor(ptx("a", { personal_finance_category: { primary: "TRAVEL" } }), [], (n) => (n === "Other" ? "id-other" : null)), "id-other");
  assert.equal(merchantOf(ptx("a", { merchant_name: null })), "STARBUCKS #123");
});
test("planSync: inserts new, dedupes on re-sync (existing externalId -> update, never a 2nd insert)", () => {
  const page = { added: [ptx("t1"), ptx("t2", { amount: -500, personal_finance_category: { primary: "INCOME" } })], modified: [], removed: [] };
  const ops = planSync(page, [], catFor, newId);
  assert.deepEqual(ops.map((o) => o.op), ["insert", "insert"]);
  assert.equal(ops[0].row.amountCents, 1234);
  assert.equal(ops[1].row.amountCents, -50000, "inflow becomes negative (income)");
  assert.equal(ops[1].row.categoryId, "id-income");
  const existing = ops.map((o) => ({ id: o.row.id, externalId: o.row.externalId, userEdited: 0, deleted: 0 }));
  const again = planSync(page, existing, catFor, newId);
  assert.deepEqual(again.map((o) => o.op), ["update", "update"]);
  assert.equal(again[0].id, existing[0].id);
});
test("planSync: duplicate ids inside one page collapse to one row", () => {
  const ops = planSync({ added: [ptx("t1")], modified: [ptx("t1", { amount: 20 })], removed: [] }, [], catFor, newId);
  assert.deepEqual(ops.map((o) => o.op), ["insert", "update"]);
  assert.equal(ops[1].id, ops[0].row.id);
});
test("planSync: pending -> posted re-keys the pending row (keeps id + user edits) and ignores the removed pending id", () => {
  const existing = [{ id: "L-p", externalId: "p1", userEdited: 1, deleted: 0 }];
  const page = { added: [ptx("t9", { pending_transaction_id: "p1", amount: 13.5 })], modified: [], removed: ["p1"] };
  const ops = planSync(page, existing, catFor, newId);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "update");
  assert.equal(ops[0].id, "L-p");
  assert.equal(ops[0].set.externalId, "t9");
  assert.equal(ops[0].set.pending, 0);
  assert.equal(ops[0].set.amountCents, 1350);
  assert.equal(ops[0].set.categoryId, undefined, "user-edited category preserved");
  assert.equal(ops[0].set.merchant, undefined, "user-edited merchant preserved");
});
test("planSync: not-edited rows get merchant/category refreshed on modify", () => {
  const ops = planSync({ added: [], modified: [ptx("t1", { merchant_name: "Whole Foods", personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" } })], removed: [] },
    [{ id: "L1", externalId: "t1", userEdited: 0, deleted: 0 }], catFor, newId);
  assert.equal(ops[0].set.merchant, "Whole Foods");
  assert.equal(ops[0].set.categoryId, "id-groceries");
});
test("planSync: removed -> tombstone; unknown removed ids ignored; already-deleted not re-tombstoned", () => {
  const ops = planSync({ added: [], modified: [], removed: ["t1", "nope", "t2"] },
    [{ id: "L1", externalId: "t1", userEdited: 0, deleted: 0 }, { id: "L2", externalId: "t2", userEdited: 0, deleted: 1 }], catFor, newId);
  assert.deepEqual(ops, [{ op: "tombstone", id: "L1" }]);
});
test("merge: same bank transaction imported on two devices collapses to one live row", () => {
  const bt = (id, upd, extra = {}) => tx(id, "Starbucks", upd, { source: "bank", externalId: "ext1", pending: 0, accountId: "acc1", userEdited: 0, ...extra });
  const a = snap({ transactions: [bt("aaa", "2026-11-01T00:00:00Z")] });
  const b = snap({ transactions: [bt("bbb", "2026-11-02T00:00:00Z", { userEdited: 1, categoryId: "c2" })] });
  const m = mergeSnapshots(a, b, "N");
  const live = m.transactions.filter((t) => !t.deleted);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, "bbb", "user-edited copy wins");
  const loser = m.transactions.find((t) => t.id === "aaa");
  assert.equal(loser.deleted, 1); assert.equal(loser.externalId, null);
  assert.deepEqual(mergeSnapshots(b, a, "N"), m, "commutative");
  assert.deepEqual(mergeSnapshots(m, a, "N").transactions.filter((t) => !t.deleted).map((t) => t.id), ["bbb"], "stale duplicate doesn't come back");
});
test("merge: accounts, link items and rules merge LWW; a null token never erases a live one", () => {
  const item = (upd, extra = {}) => ({ id: "item1", institution: "Bank", accessToken: "access-x", cursor: "c1", status: "ok", createdAt: "2026-11-01", updatedAt: upd, deleted: 0, ...extra });
  const a = snap({ linkItems: [item("2026-11-01T00:00:00Z")], accounts: [{ id: "acc1", itemId: "item1", name: "Chq", currentCents: 100, updatedAt: "2026-11-01", deleted: 0 }], rules: [{ id: "r1", pattern: "uber", categoryId: "c1", createdAt: "x", updatedAt: "2026-11-01", deleted: 0 }] });
  const b = snap({ linkItems: [item("2026-11-03T00:00:00Z", { accessToken: null, cursor: "c2" })], accounts: [{ id: "acc1", itemId: "item1", name: "Chq", currentCents: 250, updatedAt: "2026-11-03", deleted: 0 }] });
  const m = mergeSnapshots(a, b, "N");
  assert.equal(m.linkItems[0].cursor, "c2");
  assert.equal(m.linkItems[0].accessToken, "access-x");
  assert.equal(m.accounts[0].currentCents, 250);
  assert.equal(m.rules.length, 1);
  const old = mergeSnapshots(snap(), snap(), "N");
  assert.deepEqual([old.accounts, old.linkItems, old.rules], [[], [], []], "old snapshots without bank tables still merge");
});
