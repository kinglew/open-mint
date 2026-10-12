"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getMeta, query } from "@/lib/db";
import { SyncAgent } from "./SyncAgent";

const REMIND_DAYS = 14;

// Registers the offline service worker and nudges users to back up periodically.
export function AppShell() {
  const pathname = usePathname();
  const [remind, setRemind] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    if (navigator.storage?.persist) void navigator.storage.persist();
    const upd = () => setOffline(!navigator.onLine);
    upd();
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
    };
  }, []);

  useEffect(() => {
    (async () => {
      const [{ n }] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM txn WHERE deleted=0");
      if (!n) return setRemind(false);
      const last = await getMeta("lastBackup");
      setRemind(!last || Date.now() - Date.parse(last) > REMIND_DAYS * 864e5);
    })().catch(() => {});
  }, [pathname]);

  return (
    <>
      <SyncAgent />
      {offline && <p className="bg-slate-800 px-4 py-1 text-center text-xs text-white">Offline — everything still works; data is on this device.</p>}
      {remind && pathname !== "/backup/" && pathname !== "/backup" && (
        <Link href="/backup/" className="block bg-amber-100 px-4 py-2 text-center text-xs text-amber-900" data-testid="backup-reminder">
          Your data lives only on this device. <span className="font-semibold underline">Back up now</span>
        </Link>
      )}
    </>
  );
}
