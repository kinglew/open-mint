"use client";

import { useEffect, useRef, useState } from "react";
import { exportSnapshot, getMeta, importSnapshot, liveCounts, setMeta, storageInfo } from "@/lib/db";
import { decryptBackup, encryptSnapshot, type BackupFile } from "@/lib/backup";

export default function BackupPage() {
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [importPass, setImportPass] = useState("");
  const [mode, setMode] = useState<"replace" | "merge">("replace");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const [storage, setStorage] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getMeta("lastBackup").then(setLast);
    storageInfo().then((i) => setStorage(i.storage)).catch(() => setStorage("unavailable"));
  }, []);

  async function onExport(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    if (pass.length < 8) return setErr("Use a passphrase of at least 8 characters.");
    if (pass !== pass2) return setErr("Passphrases don't match.");
    setBusy(true);
    try {
      const file = await encryptSnapshot(await exportSnapshot(), pass);
      const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `mint-backup-${new Date().toISOString().slice(0, 10)}.mintbackup`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      const t = new Date().toISOString();
      await setMeta("lastBackup", t);
      setLast(t);
      setPass(""); setPass2("");
      setMsg("Encrypted backup downloaded. Store it somewhere safe (e.g. your own cloud drive).");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    const f = fileRef.current?.files?.[0];
    if (!f) return setErr("Choose a backup file.");
    if (mode === "replace" && !confirm("Replace ALL data on this device with the backup?")) return;
    setBusy(true);
    try {
      const snap = await decryptBackup(JSON.parse(await f.text()) as BackupFile, importPass);
      await importSnapshot(snap, mode);
      setImportPass("");
      const c = liveCounts(snap);
      setMsg(`Restored ${c.txns} expenses, ${c.budgets} budgets, ${c.categories} categories (${mode}).`);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-emerald-500";
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Backup &amp; restore</h2>
        <p className="text-sm text-slate-500">
          Your data lives only on this device{storage ? ` (storage: ${storage === "opfs" ? "SQLite in browser OPFS" : storage})` : ""}. There is no server copy.
        </p>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">⚠️ No recovery</p>
        <p className="mt-1">
          We never see your data or your passphrase. If you lose this device (or clear site data) without a backup, or forget the
          backup passphrase, your data cannot be recovered by anyone. Back up regularly.
        </p>
        <p className="mt-1 text-xs" data-testid="last-backup">Last backup: {last ? new Date(last).toLocaleString() : "never"}</p>
      </div>

      <form onSubmit={onExport} className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <h3 className="font-semibold text-slate-800">Export encrypted backup</h3>
        <input type="password" className={input} placeholder="Passphrase (min 8 chars)" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Export passphrase" />
        <input type="password" className={input} placeholder="Confirm passphrase" value={pass2} onChange={(e) => setPass2(e.target.value)} aria-label="Confirm passphrase" />
        <button disabled={busy} className="w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white disabled:opacity-60">Export backup</button>
        <p className="text-xs text-slate-400">AES-256-GCM, key derived with PBKDF2-SHA256 (600,000 iterations). Encrypted on-device.</p>
      </form>

      <form onSubmit={onImport} className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
        <h3 className="font-semibold text-slate-800">Import backup</h3>
        <input ref={fileRef} type="file" accept=".mintbackup,application/json" className="block w-full text-sm" aria-label="Backup file" />
        <input type="password" className={input} placeholder="Backup passphrase" value={importPass} onChange={(e) => setImportPass(e.target.value)} aria-label="Import passphrase" />
        <div className="flex gap-4 text-sm text-slate-700">
          <label className="flex items-center gap-1"><input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} /> Replace all</label>
          <label className="flex items-center gap-1"><input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge</label>
        </div>
        <button disabled={busy} className="w-full rounded-xl border border-emerald-600 py-3 font-semibold text-emerald-700 disabled:opacity-60">Import backup</button>
      </form>

      {msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{msg}</p>}
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{err}</p>}
    </div>
  );
}
