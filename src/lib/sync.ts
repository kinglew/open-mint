"use client";
// Optional Google Drive sync — 100% client-side, end-to-end encrypted.
//  * Auth: Google Identity Services token client (browser OAuth token flow, no client secret, no backend).
//  * Scope: drive.appdata only — a hidden per-app folder in the user's own Drive.
//  * Crypto: key derived from the user's *sync passphrase* (PBKDF2-SHA256 600k -> AES-256-GCM).
//    Never derived from the Google login; Google only ever stores ciphertext.
//  * Model: one encrypted snapshot file, merged per-record (LWW + tombstones), with a Drive
//    version check before upload and retry on conflict.
import { applySyncedSnapshot, exportSnapshot, type Snapshot } from "./db";
import { ITER, b64, deriveKey, openJSON, sealJSON, unb64 } from "./backup";
import { mergeSnapshots } from "./merge";

export const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
export const FILE_NAME = "open-mint-sync.enc";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const LS_STATE = "openmint.sync.state";
const LS_CLIENT = "openmint.sync.clientId";
const SS_TOKEN = "openmint.sync.token";
export const STATUS_EVENT = "openmint:sync-status";

export type SyncFile = {
  format: "open-mint-sync"; v: 1; kdf: "PBKDF2-SHA256"; iter: number; salt: string; iv: string; ct: string;
  deviceId: string; updatedAt: string; schemaVersion: number;
};
export type SyncState = {
  connected: boolean; deviceId: string; fileId?: string; lastSynced?: string; lastVersion?: string;
  error?: string; syncing?: boolean; needsPassphrase?: boolean; needsReconnect?: boolean; remembered?: boolean;
};

// ---------- config + persisted state
export function envClientId(): string { return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ""; }
export function getClientId(): string {
  return envClientId() || (typeof localStorage !== "undefined" ? localStorage.getItem(LS_CLIENT) || "" : "");
}
export function setCustomClientId(id: string) {
  if (id.trim()) localStorage.setItem(LS_CLIENT, id.trim()); else localStorage.removeItem(LS_CLIENT);
  emit();
}
export function getState(): SyncState {
  let s: Partial<SyncState> = {};
  try { s = JSON.parse(localStorage.getItem(LS_STATE) || "{}"); } catch {}
  if (!s.deviceId) { s.deviceId = crypto.randomUUID(); localStorage.setItem(LS_STATE, JSON.stringify(s)); }
  const st = { connected: false, ...s } as SyncState;
  st.syncing = running !== null;
  st.needsPassphrase = st.connected && !session;
  st.needsReconnect = st.connected && !tokenValid();
  return st;
}
function patchState(p: Partial<SyncState>) {
  const cur = getState();
  const next = { ...cur, ...p };
  delete next.syncing; delete next.needsPassphrase; delete next.needsReconnect;
  localStorage.setItem(LS_STATE, JSON.stringify(next));
  emit();
}
function emit() { if (typeof window !== "undefined") window.dispatchEvent(new Event(STATUS_EVENT)); }

// ---------- Google Identity Services token client
type TokenResp = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
type Gis = { accounts: { oauth2: {
  initTokenClient: (c: { client_id: string; scope: string; callback: (r: TokenResp) => void; error_callback?: (e: { type?: string; message?: string }) => void }) => { requestAccessToken: (o?: { prompt?: string }) => void };
  revoke: (t: string, cb?: () => void) => void;
} } };
declare global { interface Window { google?: Gis } }

let gisLoading: Promise<Gis> | null = null;
function loadGis(): Promise<Gis> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  if (!gisLoading) gisLoading = new Promise<Gis>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => (window.google ? resolve(window.google) : reject(new Error("Google sign-in failed to load")));
    s.onerror = () => { gisLoading = null; reject(new Error("Couldn't reach Google (offline?)")); };
    document.head.appendChild(s);
  });
  return gisLoading;
}
function tokenValid(): boolean {
  try { const t = JSON.parse(sessionStorage.getItem(SS_TOKEN) || "null"); return !!t && t.exp > Date.now() + 60_000; } catch { return false; }
}
function token(): string | null {
  if (!tokenValid()) return null;
  return JSON.parse(sessionStorage.getItem(SS_TOKEN) as string).token;
}
/** Must be called from a user gesture (opens Google's consent popup). */
export async function requestToken(prompt: "" | "consent" = ""): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error("Google Drive sync is not configured");
  const gis = await loadGis();
  await new Promise<void>((resolve, reject) => {
    const client = gis.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) return reject(new Error(r.error_description || r.error || "Google sign-in was cancelled"));
        sessionStorage.setItem(SS_TOKEN, JSON.stringify({ token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 }));
        resolve();
      },
      error_callback: (e) => reject(new Error(e?.message || (e?.type === "popup_closed" ? "Google sign-in was cancelled" : "Google sign-in failed"))),
    });
    client.requestAccessToken({ prompt });
  });
  patchState({ connected: true, error: undefined });
}

// ---------- Drive REST v3
class AuthError extends Error {}
async function drive(url: string, init: RequestInit = {}): Promise<Response> {
  const t = token();
  if (!t) throw new AuthError("Google session expired — reconnect to resume sync");
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` } });
  if (res.status === 401) { sessionStorage.removeItem(SS_TOKEN); throw new AuthError("Google session expired — reconnect to resume sync"); }
  if (!res.ok) throw new Error(`Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}
type FileMeta = { id: string; version: string; modifiedTime?: string };
async function findFile(): Promise<FileMeta | null> {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const r = await drive(`${DRIVE}/files?spaces=appDataFolder&q=${q}&fields=files(id,version,modifiedTime)&pageSize=10`);
  const { files } = (await r.json()) as { files: FileMeta[] };
  return files?.[0] ?? null;
}
async function download(id: string): Promise<SyncFile> {
  return (await drive(`${DRIVE}/files/${id}?alt=media`)).json();
}
async function upload(body: SyncFile, id?: string): Promise<FileMeta> {
  const json = JSON.stringify(body);
  if (id) {
    const r = await drive(`${UPLOAD}/files/${id}?uploadType=media&fields=id,version,modifiedTime`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: json });
    return r.json();
  }
  const boundary = "openmint" + crypto.randomUUID().replace(/-/g, "");
  const meta = { name: FILE_NAME, parents: ["appDataFolder"], mimeType: "application/json" };
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${json}\r\n--${boundary}--`;
  const r = await drive(`${UPLOAD}/files?uploadType=multipart&fields=id,version,modifiedTime`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart });
  return r.json();
}

// ---------- key handling (memory; optional non-extractable CryptoKey in IndexedDB)
let session: { salt: string; key: CryptoKey } | null = null;
const IDB = "openmint-sync";
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(IDB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("keys");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("keys", mode);
      const req = fn(tx.objectStore("keys"));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => open.result.close();
    };
  });
}
export async function loadRememberedKey(): Promise<boolean> {
  if (session) return true;
  try {
    const k = await idb<{ salt: string; key: CryptoKey } | undefined>("readonly", (s) => s.get("k"));
    if (k?.key && k.salt) { session = k; emit(); return true; }
  } catch {}
  return false;
}
async function forgetKey() {
  session = null;
  try { await idb("readwrite", (s) => s.delete("k")); } catch {}
}

/** Unlock sync with the passphrase. If a remote copy exists, the passphrase must decrypt it. */
export async function unlock(pass: string, opts: { remember: boolean }): Promise<"existing" | "new"> {
  if (pass.length < 8) throw new Error("Use a sync passphrase of at least 8 characters.");
  const meta = await findFile();
  let salt: Uint8Array, kind: "existing" | "new";
  let remote: SyncFile | null = null;
  if (meta) { remote = await download(meta.id); salt = unb64(remote.salt); kind = "existing"; }
  else { salt = crypto.getRandomValues(new Uint8Array(16)); kind = "new"; }
  const key = await deriveKey(pass, salt, remote?.iter ?? ITER);
  if (remote) {
    try { await openJSON(key, remote.iv, remote.ct); } catch { throw new Error("Wrong sync passphrase — it must match the one used on your other devices."); }
  }
  session = { salt: b64(salt), key };
  if (opts.remember) { try { await idb("readwrite", (s) => s.put(session, "k")); } catch {} }
  else await forgetKey().then(() => { session = { salt: b64(salt), key }; });
  patchState({ remembered: opts.remember, error: undefined, fileId: meta?.id });
  return kind;
}

// ---------- sync
let running: Promise<void> | null = null;
let again = false;
export function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    emit();
    try {
      do { again = false; await syncOnce(); } while (again);
      patchState({ lastSynced: new Date().toISOString(), error: undefined });
    } catch (e) {
      patchState({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally { running = null; emit(); }
  })();
  return running;
}

async function syncOnce() {
  const st = getState();
  if (!st.connected) throw new Error("Google Drive is not connected");
  if (!session) throw new Error("Enter your sync passphrase to sync");
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Offline — will sync when back online");
  for (let attempt = 0; attempt < 4; attempt++) {
    const meta = await findFile();
    let remote: Snapshot | null = null;
    if (meta) {
      const f = await download(meta.id);
      if (f.format !== "open-mint-sync") throw new Error("Unrecognised sync file in Drive");
      if (f.salt !== session.salt) { await forgetKey(); emit(); throw new Error("The sync passphrase was changed on another device — enter it again"); }
      try { remote = await openJSON<Snapshot>(session.key, f.iv, f.ct); }
      catch { await forgetKey(); emit(); throw new Error("Wrong sync passphrase"); }
    }
    const merged = mergeSnapshots(await exportSnapshot(), remote);
    await applySyncedSnapshot(merged);
    const sealed = await sealJSON(session.key, merged);
    const body: SyncFile = { format: "open-mint-sync", v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: session.salt, ...sealed, deviceId: st.deviceId, updatedAt: new Date().toISOString(), schemaVersion: 1 };
    // Optimistic concurrency: if someone else uploaded since we read, merge again.
    const check = await findFile();
    if ((check?.id ?? null) !== (meta?.id ?? null) || (check?.version ?? null) !== (meta?.version ?? null)) continue;
    const saved = await upload(body, meta?.id);
    patchState({ fileId: saved.id, lastVersion: saved.version });
    return;
  }
  throw new Error("Sync conflict kept repeating — try again");
}

export async function deleteRemoteCopy() {
  const meta = await findFile();
  if (meta) await drive(`${DRIVE}/files/${meta.id}`, { method: "DELETE" });
  patchState({ fileId: undefined, lastVersion: undefined, lastSynced: undefined });
}

export async function disconnect() {
  const t = token();
  sessionStorage.removeItem(SS_TOKEN);
  await forgetKey();
  if (t) { try { (await loadGis()).accounts.oauth2.revoke(t); } catch {} }
  const { deviceId } = getState();
  localStorage.setItem(LS_STATE, JSON.stringify({ deviceId, connected: false }));
  emit();
}

export function isAuthError(e: unknown) { return e instanceof AuthError; }
