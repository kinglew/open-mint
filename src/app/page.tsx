"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { currentMonth, formatCents, formatMonthLabel } from "@/lib/format";
import { BudgetBar } from "@/components/BudgetBar";
import { isIncome, listBudgets, listTxns } from "@/lib/db";

async function getDashboard() {
  const month = currentMonth();
  const [budgets, transactions] = await Promise.all([listBudgets(month), listTxns(month)]);
  const spendByCategory: Record<string, number> = {};
  let totalSpend = 0;
  let totalIncome = 0;
  for (const tx of transactions) {
    if (isIncome(tx)) totalIncome += Math.abs(tx.amountCents);
    else {
      totalSpend += tx.amountCents;
      spendByCategory[tx.categoryId] = (spendByCategory[tx.categoryId] || 0) + tx.amountCents;
    }
  }
  const totalBudget = budgets.reduce((s, b) => s + b.amountCents, 0);
  const budgetProgress = budgets.map((b) => ({ ...b, spentCents: spendByCategory[b.categoryId] || 0 }));
  return { month, totalSpend, totalIncome, totalBudget, budgetProgress, recent: transactions.slice(0, 8) };
}
type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

export default function DashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getDashboard().then(setData).catch((e) => setErr(String(e?.message || e)));
  }, []);
  if (err) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>;
  if (!data) return <p className="text-sm text-slate-500">Loading your on-device data…</p>;
  const remaining = data.totalBudget - data.totalSpend;
  const spendPct =
    data.totalBudget > 0
      ? Math.min(100, Math.round((data.totalSpend / data.totalBudget) * 100))
      : 0;

  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 p-5 text-white shadow-md">
        <p className="text-sm text-emerald-100">
          {formatMonthLabel(data.month)}
        </p>
        <p className="mt-1 text-3xl font-bold tracking-tight">
          {formatCents(data.totalSpend)}
          <span className="ml-2 text-base font-normal text-emerald-100">
            spent
          </span>
        </p>
        {data.totalBudget > 0 ? (
          <>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-white"
                style={{ width: `${spendPct}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-emerald-50">
              {formatCents(Math.abs(remaining))}{" "}
              {remaining >= 0 ? "left of" : "over"}{" "}
              {formatCents(data.totalBudget)} budget
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-emerald-100">
            No budgets yet —{" "}
            <Link href="/budgets/" className="underline">
              set them up
            </Link>
          </p>
        )}
        {data.totalIncome > 0 && (
          <p className="mt-1 text-xs text-emerald-100/90">
            Income this month: {formatCents(data.totalIncome)}
          </p>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Link
          href="/expenses/new/"
          className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-sm transition hover:border-emerald-200"
        >
          <span className="text-2xl">➕</span>
          <p className="mt-1 text-sm font-semibold text-slate-800">Add expense</p>
        </Link>
        <Link
          href="/receipts/new/"
          className="rounded-2xl border border-slate-100 bg-white p-4 text-center shadow-sm transition hover:border-emerald-200"
        >
          <span className="text-2xl">📷</span>
          <p className="mt-1 text-sm font-semibold text-slate-800">Scan receipt</p>
        </Link>
      </section>

      {data.budgetProgress.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800">Budgets</h2>
            <Link
              href="/budgets/"
              className="text-sm font-medium text-emerald-700"
            >
              Edit
            </Link>
          </div>
          {data.budgetProgress.slice(0, 5).map((b) => (
            <BudgetBar
              key={b.id}
              label={b.category.name}
              icon={b.category.icon}
              color={b.category.color}
              spentCents={b.spentCents}
              budgetCents={b.amountCents}
            />
          ))}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">
            Recent expenses
          </h2>
          <Link
            href="/expenses/"
            className="text-sm font-medium text-emerald-700"
          >
            See all
          </Link>
        </div>
        {data.recent.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            No expenses this month yet. Add one manually or scan a receipt.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm">
            {data.recent.map((tx) => (
              <li
                key={tx.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-800">
                    {tx.merchant}
                  </p>
                  <p className="text-xs text-slate-500">
                    {tx.category.icon} {tx.category.name} · {tx.date}
                    {tx.source === "ocr" ? " · OCR" : ""}
                  </p>
                </div>
                <span className="shrink-0 font-semibold text-slate-800">
                  {formatCents(tx.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
