// Pure bank-import logic (no I/O) — unit-tested in scripts/test-merge.mjs.
//  * Plaid personal_finance_category -> Open Mint category name (mapping table)
//  * User rules (merchant contains pattern -> category) win over the table
//  * planSync(): turns one /transactions/sync page into insert/update/tombstone ops with
//    de-duplication by Plaid transaction_id, pending -> posted hand-off, and removals.

export type PlaidTxn = {
  transaction_id: string; account_id: string; amount: number; iso_currency_code?: string | null;
  date: string; authorized_date?: string | null; name?: string | null; merchant_name?: string | null;
  pending: boolean; pending_transaction_id?: string | null;
  personal_finance_category?: { primary: string; detailed?: string } | null;
};
export type SyncPage = { added: PlaidTxn[]; modified: PlaidTxn[]; removed: string[] };
export type Rule = { pattern: string; categoryId: string };
export type ExistingBankTxn = { id: string; externalId: string; userEdited: number | boolean; deleted: number | boolean };

export const TRANSFERS = "Transfers";

// Detailed codes that should not follow their primary group.
const DETAILED: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: "Groceries",
  RENT_AND_UTILITIES_RENT: "Housing",
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: "Housing",
  LOAN_PAYMENTS_CAR_PAYMENT: "Transport",
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: TRANSFERS,
  GENERAL_SERVICES_AUTOMOTIVE: "Transport",
  GENERAL_MERCHANDISE_SUPERSTORES: "Shopping",
  GENERAL_SERVICES_INSURANCE: "Other",
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: "Health",
  ENTERTAINMENT_TV_AND_MOVIES: "Entertainment",
};
// Primary groups (Plaid PFC taxonomy v1/v2 primaries).
export const PRIMARY: Record<string, string> = {
  INCOME: "Income",
  TRANSFER_IN: TRANSFERS,
  TRANSFER_OUT: TRANSFERS,
  LOAN_PAYMENTS: TRANSFERS,
  LOAN_DISBURSEMENTS: TRANSFERS,
  BANK_FEES: "Other",
  ENTERTAINMENT: "Entertainment",
  FOOD_AND_DRINK: "Dining",
  GENERAL_MERCHANDISE: "Shopping",
  HOME_IMPROVEMENT: "Housing",
  MEDICAL: "Health",
  PERSONAL_CARE: "Health",
  GENERAL_SERVICES: "Other",
  GOVERNMENT_AND_NON_PROFIT: "Other",
  TRANSPORTATION: "Transport",
  TRAVEL: "Transport",
  RENT_AND_UTILITIES: "Utilities",
};

export function mapPfc(pfc: PlaidTxn["personal_finance_category"]): string {
  if (!pfc) return "Other";
  if (pfc.detailed && DETAILED[pfc.detailed]) return DETAILED[pfc.detailed];
  return PRIMARY[pfc.primary] || "Other";
}

export function merchantOf(t: PlaidTxn): string {
  return (t.merchant_name || t.name || "Bank transaction").trim().slice(0, 200) || "Bank transaction";
}

/** First matching rule by longest pattern (case-insensitive substring of the merchant/name). */
export function matchRule(t: PlaidTxn, rules: Rule[]): string | null {
  const hay = `${t.merchant_name || ""} ${t.name || ""}`.toLowerCase();
  let best: Rule | null = null;
  for (const r of rules) {
    const p = r.pattern.trim().toLowerCase();
    if (p && hay.includes(p) && (!best || p.length > best.pattern.trim().length)) best = r;
  }
  return best?.categoryId ?? null;
}

/** Resolve a category id: rule > mapping table (by category name) > Other. */
export function categoryFor(t: PlaidTxn, rules: Rule[], idByName: (name: string) => string | null): string {
  return matchRule(t, rules) || idByName(mapPfc(t.personal_finance_category)) || idByName("Other") || "default-other";
}

export type Op =
  | { op: "insert"; row: { id: string; externalId: string; accountId: string; amountCents: number; date: string; merchant: string; categoryId: string; pending: number } }
  | { op: "update"; id: string; set: { externalId: string; accountId: string; amountCents: number; date: string; pending: number; merchant?: string; categoryId?: string } };
export type TombstoneOp = { op: "tombstone"; id: string };

export const toCents = (amount: number) => Math.round(amount * 100);

/**
 * Plan local changes for one sync page. Order matters: added, then modified, then removed — Plaid reports a
 * pending->posted transition as removed(pending id) + added(posted, pending_transaction_id=pending id), so
 * re-keying the existing pending row first preserves the user's edits and keeps a single row.
 */
export function planSync(
  page: SyncPage,
  existing: ExistingBankTxn[],
  catFor: (t: PlaidTxn) => string,
  newId: () => string,
): (Op | TombstoneOp)[] {
  const byExt = new Map<string, ExistingBankTxn>();
  for (const e of existing) byExt.set(e.externalId, { ...e });
  const ops: (Op | TombstoneOp)[] = [];
  const base = (t: PlaidTxn) => ({ externalId: t.transaction_id, accountId: t.account_id, amountCents: toCents(t.amount), date: t.date, pending: t.pending ? 1 : 0 });

  const upsert = (t: PlaidTxn) => {
    let cur = byExt.get(t.transaction_id);
    if (!cur && t.pending_transaction_id && byExt.has(t.pending_transaction_id)) {
      cur = byExt.get(t.pending_transaction_id)!;
      byExt.delete(t.pending_transaction_id);
      cur.externalId = t.transaction_id;
      byExt.set(t.transaction_id, cur);
    }
    if (cur) {
      const set: Extract<Op, { op: "update" }>["set"] = base(t);
      if (!cur.userEdited) { set.merchant = merchantOf(t); set.categoryId = catFor(t); }
      ops.push({ op: "update", id: cur.id, set }); // a user-deleted row stays deleted (tombstone is kept)
      return;
    }
    const row = { id: newId(), ...base(t), merchant: merchantOf(t), categoryId: catFor(t) };
    byExt.set(t.transaction_id, { id: row.id, externalId: t.transaction_id, userEdited: 0, deleted: 0 });
    ops.push({ op: "insert", row });
  };
  for (const t of page.added) upsert(t);
  for (const t of page.modified) upsert(t);
  for (const rid of page.removed) {
    const cur = byExt.get(rid);
    if (cur && !cur.deleted) { ops.push({ op: "tombstone", id: cur.id }); cur.deleted = 1; }
  }
  return ops;
}
