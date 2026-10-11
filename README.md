# Mint Rebuild: local-first budgeting PWA

A free Mint-style budgeting app that runs as a progressive web app. **You own your data.** Everything is stored only in your browser. There is no central database and no backend. The site is a static bundle, and no server ever sees your financial data.

## Features
- Dashboard with monthly spending and budget progress
- Expenses: add, edit, delete (manual or from a receipt scan)
- Monthly budgets per category with progress bars
- 10 default categories, seeded in the browser on first run, plus your own custom ones
- Receipt scanning: photo → Tesseract.js OCR on your device → you review → expense saved with `source=ocr`. The OCR engine and language data are self-hosted, so scanning works offline and never calls a CDN. The receipt image is not stored.
- Encrypted backup and restore (replace or merge)
- Works fully offline after the first load, and can be installed to your home screen

## How it's built
| Part | Choice |
|---|---|
| UI | Next.js 16 App Router built as a static export (`output: "export"`), React 19, Tailwind 4 |
| Storage | **SQLite WASM** (`@sqlite.org/sqlite-wasm`) in a module Web Worker (`public/db-worker.mjs`), saved to the **Origin Private File System** with the `opfs-sahpool` VFS. That VFS doesn't need COOP/COEP headers, so any static host works. The app calls `navigator.storage.persist()` so the browser is less likely to evict the data. |
| Data access | `src/lib/db.ts`: a typed client that talks to the worker over postMessage |
| Backup | `src/lib/backup.ts`: WebCrypto PBKDF2-SHA256 with 600k iterations, then AES-256-GCM. The file is JSON `{salt, iv, ct}` with the extension `.mintbackup`. |
| Offline | `scripts/gen-sw.mjs` runs after the build and writes `out/sw.js`. It precaches every exported file, including the SQLite and OCR wasm files. Pages load network-first and fall back to the cache; other files are served cache-first. |

Why SQLite in OPFS and not IndexedDB: it gives real SQL (joins, unique constraints, foreign keys), a single-file database that is easy to snapshot, and good performance. IndexedDB/Dexie would have been the fallback, but it wasn't needed.

## Run
```bash
npm install
npm run dev            # dev server at http://localhost:3000 (no service worker in dev)
npm run build          # static export to ./out, then generates out/sw.js
npm run start          # serves ./out on :3000 (any static host works: Vercel, Netlify, S3, GitHub Pages)
npm run test:e2e       # Playwright end-to-end test against :3000 (npx playwright install chromium first)
```

## Known limitations
- **No recovery.** Lose the device or clear site data without a backup, or forget the backup passphrase, and the data is gone. The UI warns about this and shows a reminder banner if you have expenses and haven't backed up in 14 days.
- **One tab at a time.** The `opfs-sahpool` VFS holds an exclusive lock, so a second tab shows an error. A future fix is to route all tabs through one SharedWorker or use Web Locks.
- Each browser and device has its own separate database until sync exists (see below). Safari private mode and very old browsers have limited or no OPFS support.
- No in-place schema migrations yet. The schema is created with `CREATE TABLE IF NOT EXISTS`, and the backup format is versioned (`version: 1`).

## Design note: future sync (optional, still user-owned)
1. **The user's own cloud.** Push the encrypted `.mintbackup` (or an encrypted change log) to the user's Google Drive, Dropbox or iCloud folder through their OAuth. We store nothing.
2. **End-to-end encrypted relay.** Each device keeps a log of changes per row (the tables already use UUID ids, plus `createdAt`/`updatedAt`). Changes are encrypted with a key derived from a recovery phrase, and a relay that cannot read them passes them between devices. Conflicts are resolved with CRDT or last-write-wins per field. Candidate tools: Evolu, Jazz, cr-sqlite, or Automerge/Yjs.
3. **Bank sync with Plaid (later).** Plaid needs a server to hold its client secret and exchange tokens. That needs a **thin pass-through server that stores nothing**: it creates link tokens, fetches transactions, and passes them straight to the device. Two things it can't avoid: the data briefly passes through its memory, and the per-user `access_token` has to live somewhere. The option that fits this design is to encrypt it to the user's key and keep it on the device, sending it along with each sync request.
