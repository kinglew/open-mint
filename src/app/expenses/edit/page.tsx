"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExpenseForm } from "@/components/ExpenseForm";
import { getTxn, type Txn } from "@/lib/db";

export default function EditExpensePage() {
  const [tx, setTx] = useState<Txn | null | undefined>(undefined);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    (id ? getTxn(id) : Promise.resolve(null)).then(setTx);
  }, []);
  return (
    <div className="space-y-4">
      <Link href="/expenses/" className="text-sm font-medium text-emerald-700">← Back</Link>
      <h2 className="text-xl font-bold text-slate-900">Edit expense</h2>
      <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        {tx === undefined ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : tx === null ? (
          <p className="text-sm text-slate-500">Expense not found.</p>
        ) : (
          <ExpenseForm editId={tx.id} submitLabel="Save changes" initial={{ ...tx, notes: tx.notes ?? "" }} />
        )}
      </div>
    </div>
  );
}
