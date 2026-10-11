"use client";

import { useCallback, useEffect, useState } from "react";
import { BudgetBar } from "@/components/BudgetBar";
import { currentMonth, formatMonthLabel, parseAmountToCents } from "@/lib/format";
import { listBudgets, listCategories, listTxns, setBudget, isIncome } from "@/lib/db";

type Category = {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
};

type Budget = {
  id: string;
  categoryId: string;
  month: string;
  amountCents: number;
  category: Category;
};

export default function BudgetsPage() {
  const month = currentMonth();
  const [categories, setCategories] = useState<Category[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [spent, setSpent] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cats, buds, txs] = await Promise.all([
        listCategories(),
        listBudgets(month),
        listTxns(month),
      ]);
      setCategories(
        (cats as Category[]).filter(
          (c) => c.name.toLowerCase() !== "income"
        )
      );
      setBudgets(buds as Budget[]);
      const map: Record<string, number> = {};
      for (const tx of txs) {
        if (isIncome(tx)) continue;
        map[tx.categoryId] = (map[tx.categoryId] || 0) + tx.amountCents;
      }
      setSpent(map);
    } catch {
      setError("Failed to load budgets");
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function saveBudget(categoryId: string, amountStr: string) {
    setError("");
    const cents = parseAmountToCents(amountStr);
    if (cents === null || cents < 0) {
      setError("Enter a valid amount");
      return;
    }
    try {
      await setBudget(categoryId, month, cents);
    } catch {
      setError("Save failed");
      return;
    }
    setEditingId(null);
    await load();
  }

  const budgetByCat = Object.fromEntries(
    budgets.map((b) => [b.categoryId, b])
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Budgets</h2>
        <p className="text-sm text-slate-500">
          Monthly targets for {formatMonthLabel(month)}
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <ul className="space-y-3">
          {categories.map((cat) => {
            const budget = budgetByCat[cat.id];
            const amount = budget?.amountCents || 0;
            const isEditing = editingId === cat.id;

            return (
              <li key={cat.id} className="space-y-2">
                {amount > 0 && !isEditing ? (
                  <BudgetBar
                    label={cat.name}
                    icon={cat.icon}
                    color={cat.color}
                    spentCents={spent[cat.id] || 0}
                    budgetCents={amount}
                  />
                ) : (
                  <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                    <div className="flex items-center gap-2">
                      <span>{cat.icon}</span>
                      <span className="font-medium text-slate-800">
                        {cat.name}
                      </span>
                    </div>
                    {!isEditing && (
                      <p className="mt-1 text-sm text-slate-500">
                        No budget set · spent{" "}
                        {((spent[cat.id] || 0) / 100).toFixed(2)}
                      </p>
                    )}
                  </div>
                )}

                {isEditing ? (
                  <div className="flex gap-2 px-1">
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                        $
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="0.00"
                        className="w-full rounded-xl border border-slate-200 py-2.5 pl-7 pr-3 outline-none focus:border-emerald-500"
                        autoFocus
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveBudget(cat.id, draft)}
                      className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(cat.id);
                      setDraft(amount > 0 ? (amount / 100).toFixed(2) : "");
                    }}
                    className="ml-1 text-sm font-medium text-emerald-700"
                  >
                    {amount > 0 ? "Edit budget" : "Set budget"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
