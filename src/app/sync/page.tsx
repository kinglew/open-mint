"use client";

import { useCallback, useEffect, useState } from "react";
import {
  STATUS_EVENT, deleteRemoteCopy, disconnect, envClientId, getClientId, getState, loadRememberedKey,
  requestToken, setCustomClientId, syncNow, unlock, type SyncState,
} from "@/lib/sync";

export default function SyncPage() {
  const [st, setSt] = useState<SyncState | null>(null);
  const [clientId, setClientId] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [remember, setRemember] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [customId, setCustomId] = useState("");

  const refresh = useCallback(() => { setSt(getState()); setClientId(getClientId()); }, []);
  useEffect(() => {
    queueMicrotask(refresh);
    loadRememberedKey().then(refresh);
    window.addEventListener(STATUS_EVENT, refresh);
    return () => window.removeEventListener(STATUS_EVENT, refresh);
  }, [refresh]);

  async function act(fn: () => Promise<void | string>) {
    setErr(""); setMsg(""); setBusy(true);
    try { const m = await fn(); if (m) setMsg(m); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); refresh(); }
  }

  const input = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-emerald-500";
  const primary = "w-full rounded-xl bg-emerald-600 py-3 font-semibold text-white disabled:opacity-60";
  const secondary = "w-full rounded-xl border border-slate-300 py-2.5 text-sm font-medium text-slate-700 disabled:opacity-60";
  if (!st) return null;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Google Drive sync</h2>
        <p className="text-sm text-slate-500">
          Optional. Keeps an end-to-end encrypted copy in a hidden app folder of <em>your own</em> Google Drive so your devices stay in
          sync. Open Mint has no server; Google only ever stores ciphertext.
        </p>
      </div>

      {!clientId ? (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm" data-testid="sync-not-configured">
          <p className="font-semibold text-slate-800">Sync is not configured on this deployment</p>
          <p className="text-slate-600">
            The site owner needs to set <code>NEXT_PUBLIC_GOOGLE_CLIENT_ID</code> (a Google OAuth Web client ID) at build time. Your data
            still works fully on this device, and you can use encrypted file backups meanwhile.
          </p>
          <details>
            <summary className="cursor-pointer text-slate-500">Advanced: use your own OAuth client ID</summary>
            <div className="mt-2 space-y-2">
              <input className={input} placeholder="xxxx.apps.googleusercontent.com" value={customId} onChange={(e) => setCustomId(e.target.value)} aria-label="OAuth client ID" />
              <button className={secondary} onClick={() => { setCustomClientId(customId); refresh(); }}>Save client ID</button>
            </div>
          </details>
        </div>
      ) : (
        <>
          <div className="rounded-2xl border border-slate-100 bg-white p-4 text-sm shadow-sm" data-testid="sync-status">
            <p>
              Status:{" "}
              <strong>
                {!st.connected ? "Not connected" : st.syncing ? "Syncing…" : st.needsReconnect ? "Reconnect needed" : st.needsPassphrase ? "Locked — enter passphrase" : "Connected"}
              </strong>
            </p>
            <p className="text-slate-500">Last synced: <span data-testid="last-synced">{st.lastSynced ? new Date(st.lastSynced).toLocaleString() : "never"}</span></p>
            {st.error && <p className="mt-1 text-red-700" data-testid="sync-error">Last error: {st.error}</p>}
            {!envClientId() && (
              <button className="mt-2 text-xs text-slate-400 underline" onClick={() => { setCustomClientId(""); refresh(); }}>Clear custom client ID</button>
            )}
          </div>

          {(!st.connected || st.needsReconnect) && (
            <button disabled={busy} className={primary} onClick={() => act(async () => { await requestToken(st.connected ? "" : "consent"); return "Google Drive connected."; })}>
              {st.connected ? "Reconnect Google Drive" : "Connect Google Drive"}
            </button>
          )}

          {st.connected && !st.needsReconnect && st.needsPassphrase && (
            <form
              className="space-y-3 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
              onSubmit={(e) => {
                e.preventDefault();
                act(async () => {
                  if (!ack) throw new Error("Please confirm you understand the passphrase can't be recovered.");
                  if (pass2 && pass !== pass2) throw new Error("Passphrases don't match.");
                  const kind = await unlock(pass, { remember });
                  setPass(""); setPass2("");
                  await syncNow();
                  return kind === "new" ? "Sync set up. Use the same passphrase on your other devices." : "Unlocked and synced with your Drive copy.";
                });
              }}
            >
              <h3 className="font-semibold text-slate-800">Sync passphrase</h3>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                <p className="font-semibold">⚠️ No recovery</p>
                <p>
                  This passphrase encrypts your data before it leaves the device. It is <strong>not</strong> your Google password and is never
                  sent anywhere. If you forget it, nobody — not us, not Google — can decrypt your synced copy. First device: choose a new one.
                  Other devices: enter the same one.
                </p>
              </div>
              <input type="password" className={input} placeholder="Sync passphrase (min 8 chars)" value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Sync passphrase" />
              <input type="password" className={input} placeholder="Confirm (first device only)" value={pass2} onChange={(e) => setPass2(e.target.value)} aria-label="Confirm sync passphrase" />
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-label="I understand there is no recovery" />
                I understand a lost passphrase can&apos;t be recovered.
              </label>
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} aria-label="Remember on this device" />
                Remember on this device (stores a non-exportable key in this browser; skip on shared devices).
              </label>
              <button disabled={busy} className={primary}>Unlock &amp; sync</button>
            </form>
          )}

          {st.connected && !st.needsPassphrase && !st.needsReconnect && (
            <button disabled={busy || st.syncing} className={primary} onClick={() => act(async () => { await syncNow(); return "Synced."; })}>
              Sync now
            </button>
          )}

          {st.connected && (
            <div className="space-y-2">
              <button disabled={busy} className={secondary} onClick={() => act(async () => { await disconnect(); return "Disconnected. Data on this device is untouched."; })}>
                Disconnect Google Drive
              </button>
              {!st.needsReconnect && (
                <button
                  disabled={busy}
                  className="w-full rounded-xl border border-red-300 py-2.5 text-sm font-medium text-red-700 disabled:opacity-60"
                  onClick={() => act(async () => {
                    if (!confirm("Delete the encrypted copy from your Google Drive? Data on this device stays.")) return;
                    await deleteRemoteCopy();
                    return "Remote copy deleted from Google Drive.";
                  })}
                >
                  Delete copy from Google Drive
                </button>
              )}
            </div>
          )}
          <p className="text-xs text-slate-400">
            Scope: drive.appdata (hidden app folder only — Open Mint can&apos;t see your other Drive files). AES-256-GCM, PBKDF2-SHA256 600k.
          </p>
        </>
      )}

      {msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{msg}</p>}
      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{err}</p>}
    </div>
  );
}
