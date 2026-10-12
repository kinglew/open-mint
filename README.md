# Open Mint: local-first budgeting PWA

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

## Optional Google Drive sync (end-to-end encrypted)

Open Mint can keep an **encrypted** copy of your data in the hidden, per-app
[`appDataFolder`](https://developers.google.com/drive/api/guides/appdata) of the user's own Google Drive,
so several devices stay in sync. There is still no Open Mint server and no central database.

How it works:

- **Auth:** Google Identity Services token client, entirely in the browser (no backend, no client secret).
  Only scope requested: `https://www.googleapis.com/auth/drive.appdata` (the app can't see any other Drive files).
- **Encryption:** the key is derived from a **sync passphrase** the user chooses (PBKDF2-SHA256, 600k iterations →
  AES-256-GCM), *never* from the Google login. Google only stores ciphertext. The key is kept in memory, or, if the
  user opts in to "Remember on this device", as a non-extractable `CryptoKey` in IndexedDB. **Lost passphrase = no recovery.**
- **Data model:** one file `open-mint-sync.enc` (`{format, v, kdf, iter, salt, iv, ct, deviceId, updatedAt, schemaVersion}`).
  Records carry `updatedAt` + a `deleted` tombstone (schema migration v1 in `public/db-worker.mjs`, tracked in
  `schema_migrations`). Sync = pull → decrypt → per-record last-writer-wins merge (`src/lib/merge.ts`) → apply locally
  (never overwriting a newer local edit) → re-check the Drive file `version` → upload (retry on conflict).
- **When:** on app open, ~2 s after any edit, when the device comes back online, and via **Sync now** (Sync page).

### Turning it on (Google Cloud setup)

1. In [Google Cloud Console](https://console.cloud.google.com/) create/select a project.
2. **APIs & Services → Library →** enable **Google Drive API**.
3. **OAuth consent screen** (Google Auth Platform → Branding/Audience/Data access): user type *External*, app name
   "Open Mint", support email; under *Data access* add scope `.../auth/drive.appdata` (non-sensitive). While in
   *Testing*, add test users; publish to *In production* for everyone (appdata scope needs no verification review).
4. **Credentials → Create credentials → OAuth client ID → Web application.** Authorized JavaScript origins:
   - `http://localhost:3000`
   - `https://open-mint-iota.vercel.app`
   (no redirect URIs needed; no client secret is used).
5. Set the client ID at build time: `NEXT_PUBLIC_GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com`
   (`.env.local` locally; on Vercel: `vercel env add NEXT_PUBLIC_GOOGLE_CLIENT_ID production` then redeploy).

Without a client ID the Sync page shows "not configured" (self-hosters can paste their own client ID under *Advanced*).

### Tests

- `npm run test:unit`: merge (LWW, tombstones, default-category dedupe, commutativity) + encryption.
- `npm run test:sync`: two isolated browser contexts (two devices) against a mocked GIS + Drive API; asserts
  uploads are ciphertext only. `BASE=https://… npm run test:sync` runs it against a deployment.
- `npm run test:e2e`: core app flow (13 steps).
