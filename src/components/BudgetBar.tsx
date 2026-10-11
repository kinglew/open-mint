import { formatCents } from "@/lib/format";

type Props = {
  label: string;
  color?: string | null;
  icon?: string | null;
  spentCents: number;
  budgetCents: number;
};

export function BudgetBar({
  label,
  color,
  icon,
  spentCents,
  budgetCents,
}: Props) {
  const pct =
    budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 0;
  const over = budgetCents > 0 && spentCents > budgetCents;
  const barColor = over ? "#ef4444" : color || "#10b981";

  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg" aria-hidden>
            {icon || "📁"}
          </span>
          <span className="truncate font-medium text-slate-800">{label}</span>
        </div>
        <span
          className={`shrink-0 text-sm font-semibold ${
            over ? "text-red-600" : "text-slate-700"
          }`}
        >
          {formatCents(spentCents)}
          <span className="font-normal text-slate-400">
            {" "}
            / {formatCents(budgetCents)}
          </span>
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: barColor }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-slate-500">
        <span>{pct}% used</span>
        {over ? (
          <span className="font-medium text-red-600">
            Over by {formatCents(spentCents - budgetCents)}
          </span>
        ) : (
          <span>{formatCents(Math.max(0, budgetCents - spentCents))} left</span>
        )}
      </div>
    </div>
  );
}
