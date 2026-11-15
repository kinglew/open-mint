"use client";
// Plaid OAuth return page (set PLAID_REDIRECT_URI=https://<your-domain>/bank/oauth/ and allow it in the Plaid dashboard).
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { resumeOAuth } from "@/lib/bank";

export default function BankOAuthPage() {
  const [msg, setMsg] = useState("Finishing bank connection…");
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    resumeOAuth().then(setMsg).catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700" role="status">{msg}</p>
      <Link href="/bank/" className="text-sm font-medium text-emerald-700">← Back to Bank accounts</Link>
    </div>
  );
}
