"use client";
// Per-device encryption key for secrets at rest (Plaid access tokens). A random, NON-extractable AES-256-GCM
// CryptoKey generated in this browser and kept in IndexedDB: script can use it but never read its bytes, and
// a copy of the SQLite file alone (e.g. from disk) does not reveal the tokens. Tokens are re-encrypted with the
// sync passphrase key inside Drive sync / backups, so another device can decrypt and re-wrap with its own key.
import { b64, unb64 } from "./backup";

const DB = "openmint-device";
let cached: Promise<CryptoKey> | null = null;

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
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

export function deviceKey(): Promise<CryptoKey> {
  if (!cached) cached = (async () => {
    const existing = await idb<CryptoKey | undefined>("readonly", (s) => s.get("device"));
    if (existing) return existing;
    const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb("readwrite", (s) => s.put(k, "device"));
    return k;
  })().catch((e) => { cached = null; throw e; });
  return cached;
}

export async function sealSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(), new TextEncoder().encode(plain)));
  return `dk1:${b64(iv)}:${b64(ct)}`;
}

export async function openSecret(sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  const [v, iv, ct] = sealed.split(":");
  if (v !== "dk1" || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) as BufferSource }, await deviceKey(), unb64(ct) as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    return null; // sealed on another device / key lost — re-link or re-sync needed
  }
}
