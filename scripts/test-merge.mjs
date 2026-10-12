// Unit tests for sync merge + encryption. Compiles src/lib/{merge,backup}.ts with tsc, runs with node:test.
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const out = mkdtempSync(join(tmpdir(), "om-unit-"));
execSync(`npx tsc src/lib/merge.ts src/lib/backup.ts --outDir ${out} --module es2022 --target es2022 --moduleResolution bundler --skipLibCheck --lib es2022,dom`, { stdio: "inherit" });
writeFileSync(join(out, "package.json"), '{"type":"module"}');
const { mergeSnapshots } = await import(join(out, "merge.js"));
const { deriveKey, sealJSON, openJSON } = await import(join(out, "backup.js"));

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
