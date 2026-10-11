"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Home", icon: "📊" },
  { href: "/expenses/", label: "Expenses", icon: "💳" },
  { href: "/budgets/", label: "Budgets", icon: "📈" },
  { href: "/receipts/new/", label: "Scan", icon: "📷" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-200 bg-white/95 backdrop-blur safe-bottom">
      <ul className="mx-auto flex max-w-lg items-stretch justify-around px-2 py-1">
        {links.map((l) => {
          const active =
            l.href === "/"
              ? pathname === "/"
              : pathname.replace(/\/$/, "").startsWith(l.href.replace(/\/$/, ""));
          return (
            <li key={l.href} className="flex-1">
              <Link
                href={l.href}
                className={`flex flex-col items-center gap-0.5 rounded-xl px-2 py-2 text-xs transition ${
                  active
                    ? "bg-emerald-50 text-emerald-700 font-semibold"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <span className="text-lg leading-none" aria-hidden>
                  {l.icon}
                </span>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
