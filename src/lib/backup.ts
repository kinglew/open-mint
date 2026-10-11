"use client";
// Passphrase-encrypted backups: PBKDF2-SHA256 (600k iterations) -> AES-256-GCM, all via WebCrypto.
import type { Snapshot } from "./db";

const ITER = 600_000;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pass: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export type BackupFile = { format: "mint-local-backup"; v: 1; kdf: "PBKDF2-SHA256"; iter: number; salt: string; iv: string; ct: string };

export async function encryptSnapshot(snap: Snapshot, pass: string): Promise<BackupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(snap))));
  let bin = ""; for (let i = 0; i < ct.length; i += 0x8000) bin += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  return { format: "mint-local-backup", v: 1, kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), iv: b64(iv), ct: btoa(bin) };
}

export async function decryptBackup(file: BackupFile, pass: string): Promise<Snapshot> {
  if (file.format !== "mint-local-backup") throw new Error("Not a Mint Rebuild backup file");
  const key = await deriveKey(pass, unb64(file.salt), file.iter);
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(file.iv) as BufferSource }, key, unb64(file.ct) as BufferSource);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new Error("Wrong passphrase or corrupted file");
  }
}
