"use client";
// Background auto-sync: on app open, after local edits (debounced), and when coming back online.
import { useEffect } from "react";
import { LOCAL_CHANGE_EVENT } from "@/lib/db";
import { getClientId, getState, loadRememberedKey, syncNow } from "@/lib/sync";

const DEBOUNCE_MS = 2000;

export function SyncAgent() {
  useEffect(() => {
    if (!getClientId()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = () => { const s = getState(); return s.connected && !s.needsPassphrase && !s.needsReconnect && navigator.onLine; };
    const tryNow = () => { if (ready()) syncNow().catch(() => {}); };
    const later = () => { clearTimeout(timer); timer = setTimeout(tryNow, DEBOUNCE_MS); };
    loadRememberedKey().finally(tryNow);
    window.addEventListener(LOCAL_CHANGE_EVENT, later);
    window.addEventListener("online", tryNow);
    return () => { clearTimeout(timer); window.removeEventListener(LOCAL_CHANGE_EVENT, later); window.removeEventListener("online", tryNow); };
  }, []);
  return null;
}
