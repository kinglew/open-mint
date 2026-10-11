"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { currentMonth, formatCents, formatMonthLabel } from "@/lib/format";
import { deleteTxn, listTxns, type Txn } from "@/lib/db";

export default function ExpensesPage() {
  const month = currentMonth();
  const [transactions, setTxns] = useState<Txn[] | null>(null);
  const load = useCallback(() => listTxns(month).then(setTxns), [month]);
  useEffect(() => {
    void load();
  }, [load]);

  async function onDelete(id: string) {
    if (!confirm("Delete this expense?")) return;
    await deleteTxn(id);
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Expenses</h2>
          <p className="text-sm text-slate-500">{formatMonthLabel(month)}</p>
        </div>
        <Link href="/expenses/new/" className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700">
          + Add
        </Link>
      </div>

      {transactions === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : transactions.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No expenses yet.{" "}
          <Link href="/expenses/new/" className="font-medium text-emerald-700">Add one</Link> or{" "}
          <Link href="/receipts/new/" className="font-medium text-emerald-700">scan a receipt</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm">
          {transactions.map((tx) => (
            <li key={tx.id} className="flex items-center justify-between gap-3 px-4 py-3" data-testid="expense-row">
              <Link href={`/expenses/edit/?id=${tx.id}`} className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-800">{tx.merchant}</p>
                <p className="text-xs text-slate-500">
                  {tx.category.icon} {tx.category.name} · {tx.date}
                  {tx.source === "ocr" ? " · OCR" : " · manual"}
                </p>
                {tx.notes && <p className="truncate text-xs text-slate-400">{tx.notes}</p>}
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-semibold text-slate-800">{formatCents(tx.amountCents)}</span>
                <button type="button" onClick={() => void onDelete(tx.id)} aria-label="Delete expense" className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-red-50 hover:text-red-600">
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
