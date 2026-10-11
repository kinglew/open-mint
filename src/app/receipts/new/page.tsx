import { ReceiptCapture } from "@/components/ReceiptCapture";

export default function NewReceiptPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Scan receipt</h2>
        <p className="text-sm text-slate-500">
          On-device OCR with Tesseract.js — review before saving
        </p>
      </div>
      <ReceiptCapture />
    </div>
  );
}
