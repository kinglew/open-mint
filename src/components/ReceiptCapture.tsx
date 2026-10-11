"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseReceiptText, type OcrParseResult } from "@/lib/ocr-parse";
import { ExpenseForm } from "./ExpenseForm";
import { useRouter } from "next/navigation";

type Stage = "capture" | "scanning" | "review";

export function ReceiptCapture() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>("capture");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [parsed, setParsed] = useState<OcrParseResult | null>(null);
  const [error, setError] = useState("");

  // Revoke ephemeral object URL on unmount / replace
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const runOcr = useCallback(async (file: File) => {
    setError("");
    setStage("scanning");
    setProgress(0);
    setStatus("Loading OCR engine…");

    const url = URL.createObjectURL(file);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });

    try {
      // Dynamic import — keeps Tesseract out of SSR / initial bundle
      const { createWorker } = await import("tesseract.js");
      setStatus("Recognizing text on-device…");

      // All OCR assets are self-hosted (and cached by the service worker) so
      // scanning works offline and no third-party CDN is contacted.
      const worker = await createWorker("eng", 1, {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract/core",
        langPath: "/tesseract/lang",
        logger: (m) => {
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setProgress(Math.round(m.progress * 100));
          }
        },
      });

      const { data } = await worker.recognize(file);
      await worker.terminate();

      const result = parseReceiptText(data.text || "");
      setParsed(result);
      setStage("review");
      setStatus("");
    } catch (err) {
      console.error(err);
      setError(
        err instanceof Error
          ? err.message
          : "OCR failed. Try a clearer photo or enter the expense manually."
      );
      setStage("capture");
    }
  }, []);

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void runOcr(file);
    e.target.value = "";
  }

  if (stage === "review" && parsed) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="font-semibold">Review OCR results</p>
          <p className="mt-1 text-emerald-800/80">
            Confidence — merchant: {parsed.confidence.merchant}, date:{" "}
            {parsed.confidence.date}, amount: {parsed.confidence.amount}. Edit
            anything before saving.
          </p>
        </div>

        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Receipt preview (ephemeral)"
            className="mx-auto max-h-40 rounded-xl border border-slate-200 object-contain"
          />
        )}

        <ExpenseForm
          initial={{
            amountCents: parsed.amountCents,
            date: parsed.date || undefined,
            merchant: parsed.merchant,
            notes: "Imported from receipt OCR",
            source: "ocr",
          }}
          submitLabel="Confirm & save expense"
          onSuccess={() => {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            router.push("/expenses/");
          }}
        />

        <button
          type="button"
          onClick={() => {
            setStage("capture");
            setParsed(null);
            if (previewUrl) {
              URL.revokeObjectURL(previewUrl);
              setPreviewUrl(null);
            }
          }}
          className="w-full rounded-xl border border-slate-200 py-3 text-sm font-medium text-slate-600"
        >
          Retake / choose another
        </button>

        <details className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs text-slate-500">
          <summary className="cursor-pointer font-medium">Raw OCR text</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">
            {parsed.rawText || "(empty)"}
          </pre>
        </details>
      </div>
    );
  }

  if (stage === "scanning") {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-100 bg-white p-8 text-center shadow-sm">
        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Scanning"
            className="max-h-48 rounded-xl object-contain opacity-80"
          />
        )}
        <p className="font-medium text-slate-800">{status || "Scanning…"}</p>
        <div className="h-2.5 w-full max-w-xs overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-sm text-slate-500">{progress}% — on-device only</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 p-8 text-center">
        <p className="text-4xl" aria-hidden>
          📷
        </p>
        <h2 className="mt-2 text-lg font-semibold text-slate-800">
          Scan a receipt
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Photo or image file → on-device OCR (Tesseract.js) → review → expense.
          Nothing is uploaded to a cloud OCR service.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={onFileChange}
        />

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-xl bg-emerald-600 px-6 py-3.5 font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            Take photo / choose file
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <p className="text-center text-xs text-slate-400">
        Tip: good lighting and a flat receipt improve accuracy. Always review
        before saving.
      </p>
    </div>
  );
}
