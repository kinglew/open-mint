"use client";

import { useCallback, useEffect, useState } from "react";
import { addCategory, deleteCategory, listCategories } from "@/lib/db";

type Category = {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  isDefault: boolean;
};

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🏷️");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listCategories();
      setCategories(data);
    } catch {
      setError("Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return;
    try {
      await addCategory(name.trim(), icon);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add");
      return;
    }
    setName("");
    await load();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this custom category?")) return;
    try {
      await deleteCategory(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      return;
    }
    await load();
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Categories</h2>
        <p className="text-sm text-slate-500">
          Defaults plus your custom labels
        </p>
      </div>

      <form
        onSubmit={onAdd}
        className="flex flex-wrap gap-2 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
      >
        <input
          type="text"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          className="w-14 rounded-xl border border-slate-200 px-2 py-2.5 text-center text-lg outline-none focus:border-emerald-500"
          aria-label="Icon emoji"
          maxLength={4}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category name"
          className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
        >
          Add
        </button>
      </form>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm">
          {categories.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full text-lg"
                  style={{ backgroundColor: `${c.color || "#6b7280"}22` }}
                >
                  {c.icon || "📁"}
                </span>
                <div>
                  <p className="font-medium text-slate-800">{c.name}</p>
                  <p className="text-xs text-slate-400">
                    {c.isDefault ? "Default" : "Custom"}
                  </p>
                </div>
              </div>
              {!c.isDefault && (
                <button
                  type="button"
                  onClick={() => void onDelete(c.id)}
                  className="text-xs font-medium text-red-600"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
