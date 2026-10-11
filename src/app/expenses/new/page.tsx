import Link from "next/link";
import { ExpenseForm } from "@/components/ExpenseForm";

export default function NewExpensePage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/expenses/"
          className="text-sm font-medium text-emerald-700"
        >
          ← Back
        </Link>
      </div>
      <h2 className="text-xl font-bold text-slate-900">New expense</h2>
      <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <ExpenseForm />
      </div>
    </div>
  );
}
