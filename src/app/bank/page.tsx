"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/lib/format";
import { listCategories, type Category } from "@/lib/db";
import {
  BANK_EVENT, TRIAL_ITEM_CAP, addRule, applyRulesToExisting, clearApiKey, deleteRule, getApiKey, getBankStatus,
  isSyncing, lifetimeItemCount, linkNewBank, listAccounts, listItems, listRules, netWorth, reconnectItem, removeItem,
  saveApiKey, syncAll, type BankAccount, type BankStatus, type CategoryRule, type LinkItem,
} from "@/lib/bank";

type View = { status: BankStatus; hasKey: boolean; items: LinkItem[]; accounts: BankAccount[]; lifetime: number; rules: CategoryRule[]; cats: Category[]; syncing: boolean };

export default function BankPage() {
  const [v, setV] = useState<View | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pattern, setPattern] = useState("");
  const [ruleCat, setRuleCat] = useState("");

  const refresh = useCallback(async () => {
    const [status, items, accounts, lifetime, rules, cats] = await Promise.all([getBankStatus(), listItems(), listAccounts(), lifetimeItemCount(), listRules(), listCategories()]);
    setV({ status, hasKey: !!getApiKey(), items, accounts, lifetime, rules, cats, syncing: isSyncing() });
  }, []);
  useEffect(() => {
    queueMicrotask(() => void refresh());
    const h = () => void refresh();
    window.addEventListener(BANK_EVENT, h);
    return () => window.removeEventListener(BANK_EVENT, h);
  }, [refresh]);

  async function act(fn: () => Promise<string | void>) {
    setErr(""); setMsg(""); setBusy(true);
    try { const m = await fn(); if (m) setMsg(m); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); void refresh(); }
  }

  const input = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-emerald-500";
  const primary = "w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white disabled:opacity-60";
  const secondary = "rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60";
  if (!v) return <p className="text-sm text-slate-500">Loading…</p>;
  const ready = v.status.configured && v.hasKey;
  const nw = netWorth(v.accounts);
  const left = Math.max(0, TRIAL_ITEM_CAP - v.lifetime);

  function onLink() {
    void act(async () => {
      const sameBank = v!.items.length ? `\n\nAlready linked: ${v!.items.map((i) => i.institution).join(", ")}. Re-linking the same bank uses another slot — use Reconnect instead.` : "";
      const msgText = v!.lifetime >= TRIAL_ITEM_CAP
        ? `You've already used ${v!.lifetime} of ${TRIAL_ITEM_CAP} lifetime Plaid Trial connections. On the Trial plan this link will fail or move you to paid billing. Continue only if your Plaid account is on a paid plan.${sameBank}`
        : `Linking a bank uses 1 of your ${TRIAL_ITEM_CAP} lifetime Plaid Trial connections (${v!.lifetime} used, ${left} left). Removing a bank later does NOT give the slot back.${sameBank}\n\nContinue?`;
      if (!confirm(msgText)) return;
      const id = await linkNewBank();
      return id ? "Bank linked and synced." : "Bank linking cancelled.";
    });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Bank accounts</h2>
        <p className="text-sm text-slate-500">
          Optional, read-only bank linking through Plaid. Transactions and balances are fetched through a stateless relay and stored only on
          this device (and in your encrypted Drive sync/backups). Nothing is kept on a server.
        </p>
      </div>

      {!v.status.configured ? (
        <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 text-sm" data-testid="bank-not-configured">
          <p className="font-semibold text-slate-800">Bank linking is not configured on this deployment</p>
          <p className="text-slate-600">
            {v.status.reachable ? "The site owner needs to set " : "The bank relay isn't reachable (offline, or this host has no API functions). The owner sets "}
            <code>PLAID_CLIENT_ID</code>, <code>PLAID_SECRET</code>, <code>PLAID_ENV</code> and <code>OPEN_MINT_API_KEY</code> on the server. Manual
            expenses, receipt scanning, backups and Drive sync all keep working.
          </p>
        </div>
      ) : !v.hasKey ? (
        <form className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm" data-testid="bank-key-form"
          onSubmit={(e) => { e.preventDefault(); void act(async () => { await saveApiKey(key); setKey(""); return "API key saved on this device."; }); }}>
          <h3 className="font-semibold text-slate-800">Owner API key</h3>
          <p className="text-xs text-slate-500">
            This deployment is private to its owner. Enter the <code>OPEN_MINT_API_KEY</code> once on each device; it&apos;s stored only in this browser.
          </p>
          <input type="password" className={input} placeholder="Open Mint API key" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Open Mint API key" autoComplete="off" />
          <button disabled={busy} className={primary}>Save key</button>
        </form>
      ) : (
        <div className="flex items-center justify-between rounded-2xl border border-slate-100 bg-white p-3 text-xs text-slate-500 shadow-sm">
          <span>🔑 API key saved on this device · Plaid {v.status.env}</span>
          <button className="underline" onClick={() => { clearApiKey(); void refresh(); }}>Forget key</button>
        </div>
      )}

      {v.accounts.length > 0 && (
        <section className="rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 p-4 text-white shadow-md" data-testid="bank-networth">
          <p className="text-xs text-slate-300">Net worth (linked accounts)</p>
          <p className="text-2xl font-bold">{formatCents(nw.net)}</p>
          <p className="text-xs text-slate-300">Assets {formatCents(nw.assets)} · Liabilities {formatCents(nw.liabilities)}</p>
        </section>
      )}

      {ready && (
        <div className="space-y-3">
          <div className={`rounded-xl border p-3 text-xs ${v.lifetime >= TRIAL_ITEM_CAP - 2 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600"}`} data-testid="trial-cap">
            <p className="font-semibold">Plaid Trial: {v.lifetime} of {TRIAL_ITEM_CAP} lifetime connections used on this data set</p>
            <p>Each bank login you link is one connection. Removing one does not free its slot, so prefer <em>Reconnect</em> over re-linking. Your Plaid dashboard is the source of truth.</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button disabled={busy} className={primary} onClick={onLink}>Link a bank</button>
            <button disabled={busy || v.syncing || !v.items.length} className="rounded-xl border border-emerald-600 py-3 font-semibold text-emerald-700 disabled:opacity-50"
              onClick={() => act(async () => { const r = await syncAll(); return r.failed ? `Synced ${r.ok}, ${r.failed} need attention.` : `Synced ${r.ok} bank${r.ok === 1 ? "" : "s"}.`; })}>
              {v.syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </div>
      )}

      {v.items.length > 0 && (
        <ul className="space-y-3">
          {v.items.map((it) => {
            const accts = v.accounts.filter((a) => a.itemId === it.id);
            return (
              <li key={it.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm" data-testid="bank-item">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-800">🏦 {it.institution || "Bank"}</p>
                    <p className="text-xs text-slate-500" data-testid="bank-last-synced">Last synced: {it.lastSyncedAt ? new Date(it.lastSyncedAt).toLocaleString() : "never"}</p>
                  </div>
                  <span data-testid="bank-item-status" className={`rounded-full px-2 py-0.5 text-xs font-medium ${it.status === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                    {it.status === "ok" ? "Connected" : it.status === "login_required" ? "Login required" : "Error"}
                  </span>
                </div>
                {it.lastError && <p className="mt-1 text-xs text-red-700">Last error: {it.lastError}</p>}
                {!it.hasToken && <p className="mt-1 text-xs text-amber-700">This device can&apos;t unlock this bank&apos;s token. Sync with Drive or restore a backup.</p>}
                {accts.length > 0 && (
                  <ul className="mt-3 divide-y divide-slate-100 text-sm">
                    {accts.map((a) => (
                      <li key={a.id} className="flex justify-between py-1.5" data-testid="bank-account">
                        <span className="text-slate-700">{a.name}{a.mask ? ` ••${a.mask}` : ""} <span className="text-xs text-slate-400">{a.subtype || a.type}</span></span>
                        <span className="font-semibold text-slate-800">{a.currentCents == null ? "—" : formatCents(a.currentCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {ready && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {it.status !== "ok" && (
                      <button disabled={busy} className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                        onClick={() => act(async () => (await reconnectItem(it.id)) ? "Reconnected and synced." : "Reconnect cancelled.")}>
                        Reconnect
                      </button>
                    )}
                    <button disabled={busy} className="rounded-xl border border-red-300 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-60"
                      onClick={() => act(async () => {
                        if (!confirm(`Remove ${it.institution || "this bank"}? Plaid access is revoked; imported transactions stay. On the Plaid Trial plan this does NOT free up a connection slot.`)) return;
                        await removeItem(it.id);
                        return "Bank removed. Imported transactions were kept.";
                      })}>
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(v.items.length > 0 || v.rules.length > 0) && (
        <section className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm" data-testid="bank-rules">
          <h3 className="font-semibold text-slate-800">Category rules</h3>
          <p className="text-xs text-slate-500">When an imported merchant contains the text, use this category (beats Plaid&apos;s category). Your manual edits always win.</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { await addRule(pattern, ruleCat); setPattern(""); return "Rule added — applies to new imports."; }); }}>
            <input className={`${input} min-w-0 flex-1`} placeholder="Merchant contains…" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Rule merchant text" />
            <select className="w-32 shrink-0 rounded-xl border border-slate-200 bg-white px-2" value={ruleCat} onChange={(e) => setRuleCat(e.target.value)} aria-label="Rule category">
              <option value="">Category…</option>
              {v.cats.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
            <button disabled={busy} className={secondary}>Add</button>
          </form>
          {v.rules.length > 0 && (
            <ul className="divide-y divide-slate-100 text-sm">
              {v.rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-1.5" data-testid="bank-rule">
                  <span>“{r.pattern}” → {r.categoryIcon} {r.categoryName}</span>
                  <button className="text-xs text-slate-400 hover:text-red-600" aria-label={`Delete rule ${r.pattern}`} onClick={() => act(async () => { await deleteRule(r.id); })}>✕</button>
                </li>
              ))}
            </ul>
          )}
          {v.rules.length > 0 && (
            <button disabled={busy} className={secondary} onClick={() => act(async () => `Re-categorised ${await applyRulesToExisting()} past bank transactions.`)}>
              Apply rules to past bank transactions
            </button>
          )}
        </section>
      )}

      {msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{msg}</p>}
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{err}</p>}

      <p className="text-xs text-slate-400">
        Read-only: Open Mint can&apos;t move money. Access tokens are stored on this device encrypted with a device key and travel only inside your
        encrypted backup / Drive sync. See <Link href="/sync/" className="underline">Sync</Link> and <Link href="/backup/" className="underline">Backup</Link>.
      </p>
    </div>
  );
}
