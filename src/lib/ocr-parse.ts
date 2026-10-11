/**
 * Best-effort heuristic extraction of merchant / date / total from OCR text.
 * Always feed results into a review UI — never auto-save.
 */

export type OcrParseResult = {
  merchant: string;
  date: string; // YYYY-MM-DD or empty
  amountCents: number | null;
  rawText: string;
  confidence: {
    merchant: "low" | "medium" | "high";
    date: "low" | "medium" | "high";
    amount: "low" | "medium" | "high";
  };
};

const TOTAL_PATTERNS = [
  /(?:grand\s*)?total\s*[:\-]?\s*\$?\s*(\d{1,6}(?:[.,]\d{2})?)/i,
  /(?:amount\s*(?:due|paid)?|balance\s*due|pay\s*this\s*amount)\s*[:\-]?\s*\$?\s*(\d{1,6}(?:[.,]\d{2})?)/i,
  /\$\s*(\d{1,6}[.,]\d{2})\s*$/m,
];

const DATE_PATTERNS = [
  /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/,
  /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/,
  /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})/i,
];

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function toISODate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = y < 100 ? 2000 + y : y;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseAmount(raw: string): number | null {
  const normalized = raw.replace(",", ".");
  const n = Number.parseFloat(normalized);
  if (Number.isNaN(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 100);
}

function extractTotal(text: string): { cents: number | null; confidence: "low" | "medium" | "high" } {
  for (const re of TOTAL_PATTERNS) {
    const m = text.match(re);
    if (m?.[1]) {
      const cents = parseAmount(m[1]);
      if (cents !== null) {
        return { cents, confidence: re.source.includes("total") ? "high" : "medium" };
      }
    }
  }
  // Fallback: largest $-looking amount on the receipt
  const moneyMatches = [...text.matchAll(/\$\s*(\d{1,6}[.,]\d{2})/g)];
  let best: number | null = null;
  for (const m of moneyMatches) {
    const cents = parseAmount(m[1]);
    if (cents !== null && (best === null || cents > best)) best = cents;
  }
  return { cents: best, confidence: best !== null ? "low" : "low" };
}

function extractDate(text: string): { date: string; confidence: "low" | "medium" | "high" } {
  for (const re of DATE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;

    if (re.source.startsWith("(Jan")) {
      const month = MONTH_MAP[m[1].slice(0, 3).toLowerCase()];
      const day = Number(m[2]);
      const year = Number(m[3]);
      const iso = toISODate(year, month, day);
      if (iso) return { date: iso, confidence: "high" };
    } else if (re.source.startsWith("(\\d{4})")) {
      const iso = toISODate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) return { date: iso, confidence: "high" };
    } else {
      // Assume MM/DD/YYYY (US)
      const iso = toISODate(Number(m[3]), Number(m[1]), Number(m[2]));
      if (iso) return { date: iso, confidence: "medium" };
    }
  }
  return { date: "", confidence: "low" };
}

function extractMerchant(text: string): { merchant: string; confidence: "low" | "medium" | "high" } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 2 && !/^\d+$/.test(l));

  const skip = /^(tel|phone|www|http|receipt|invoice|thank|store\s*#|reg|#)/i;
  for (const line of lines.slice(0, 8)) {
    if (skip.test(line)) continue;
    if (/^\d{1,2}[\/\-.]\d/.test(line)) continue;
    if (/^\$/.test(line)) continue;
    // Prefer lines that look like names (letters)
    if (/[a-zA-Z]{3,}/.test(line)) {
      const cleaned = line.replace(/[^\w\s&'.-]/g, " ").replace(/\s+/g, " ").trim();
      if (cleaned.length >= 3 && cleaned.length <= 60) {
        return { merchant: cleaned, confidence: "medium" };
      }
    }
  }
  return { merchant: lines[0]?.slice(0, 60) || "", confidence: "low" };
}

export function parseReceiptText(rawText: string): OcrParseResult {
  const total = extractTotal(rawText);
  const date = extractDate(rawText);
  const merchant = extractMerchant(rawText);

  return {
    merchant: merchant.merchant,
    date: date.date,
    amountCents: total.cents,
    rawText,
    confidence: {
      merchant: merchant.confidence,
      date: date.confidence,
      amount: total.confidence,
    },
  };
}

/**
 * LAST-RESORT UNUSED STUB — cloud OCR fallback.
 * Intentionally not wired. On-device Tesseract.js is the only OCR path in Phase 1.
 * Do not call this from production UI.
 */
export async function cloudOcrFallbackStub(_imageBlob: Blob): Promise<never> {
  throw new Error(
    "Cloud OCR fallback is a last-resort unused stub and is not enabled. Use on-device Tesseract.js."
  );
}
