"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseAmountToCents, todayISO } from "@/lib/format";
import { addTxn, listCategories, updateTxn } from "@/lib/db";

type Category = {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
};

type Props = {
  initial?: {
    amountCents?: number | null;
    date?: string;
    merchant?: string;
    categoryId?: string;
    notes?: string;
    source?: "manual" | "ocr";
  };
  submitLabel?: string;
  editId?: string;
  onSuccess?: () => void;
};

export function ExpenseForm({
  initial,
  submitLabel = "Save expense",
  onSuccess,
  editId,
}: Props) {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [amount, setAmount] = useState(
    initial?.amountCents != null
      ? (Math.abs(initial.amountCents) / 100).toFixed(2)
      : ""
  );
  const [date, setDate] = useState(initial?.date || todayISO());
  const [merchant, setMerchant] = useState(initial?.merchant || "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const source = initial?.source || "manual";

  useEffect(() => {
    listCategories()
      .then((data: Category[]) => {
        setCategories(data);
        if (!categoryId && data.length) {
          const other = data.find((c) => c.name === "Other") || data[0];
          setCategoryId(other.id);
        }
      })
      .catch(() => setError("Failed to load categories"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const cents = parseAmountToCents(amount);
    if (cents === null || cents === 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!merchant.trim()) {
      setError("Merchant is required");
      return;
    }
    if (!categoryId) {
      setError("Pick a category");
      return;
    }

    setSaving(true);
    try {
      const input = {
        amountCents: cents,
        date,
        merchant: merchant.trim(),
        categoryId,
        notes: notes.trim() || null,
        source,
      } as const;
      if (editId) await updateTxn(editId, input);
      else await addTxn(input);
      if (onSuccess) onSuccess();
      else {
        router.push("/expenses/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Amount
        </span>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-xl border border-slate-200 bg-white py-3 pl-7 pr-3 text-lg font-semibold outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            required
          />
        </div>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Date
        </span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          required
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Merchant
        </span>
        <input
          type="text"
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
          placeholder="Store or payee"
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          required
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Category
        </span>
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          required
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.icon || ""} {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
        />
      </label>

      {source === "ocr" && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Source: OCR — review fields carefully before saving. Raw receipt image
          is not stored.
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full rounded-xl bg-emerald-600 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60"
      >
        {saving ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
