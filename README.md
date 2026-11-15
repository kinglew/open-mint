# Open Mint: local-first budgeting PWA

A free Mint-style budgeting app that runs as a progressive web app. **You own your data.** Everything is stored only in your browser. There is no central database. The site is a static bundle; the only server code is an *optional*, stateless Plaid relay (`api/`) that stores and logs nothing (see [Bank linking](#optional-bank-linking-plaid-read-only)).

## Features
- Dashboard with monthly spending and budget progress
- Expenses: add, edit, delete (manual or from a receipt scan)
- Monthly budgets per category with progress bars
- 10 default categories, seeded in the browser on first run, plus your own custom ones
- Receipt scanning: photo → Tesseract.js OCR on your device → you review → expense saved with `source=ocr`. The OCR engine and language data are self-hosted, so scanning works offline and never calls a CDN. The receipt image is not stored.
- Encrypted backup and restore (replace or merge)
- Optional read-only bank linking (Plaid): transactions + balances imported into your on-device database, net worth on the dashboard, merchant → category rules
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
npm run start:api      # serves ./out AND the api/ functions on :3000 (local stand-in for Vercel)
npm run test:e2e       # Playwright end-to-end test against :3000 (npx playwright install chromium first)
npm run test:bank      # Plaid flow end to end (starts its own mock Plaid + servers on :3100/:3101/:4010)
```

## Known limitations
- **No recovery.** Lose the device or clear site data without a backup, or forget the backup passphrase, and the data is gone. The UI warns about this and shows a reminder banner if you have expenses and haven't backed up in 14 days.
- **One tab at a time.** The `opfs-sahpool` VFS holds an exclusive lock, so a second tab shows an error. A future fix is to route all tabs through one SharedWorker or use Web Locks.
- Each browser and device has its own separate database until sync exists (see below). Safari private mode and very old browsers have limited or no OPFS support.
- Schema changes run as versioned migrations in `public/db-worker.mjs` (tracked in `schema_migrations`; v1 = sync columns, v2 = bank tables). The backup format is versioned (`version: 1`, bank tables optional).

## Design note: future sync (optional, still user-owned)
1. **The user's own cloud.** Push the encrypted `.mintbackup` (or an encrypted change log) to the user's Google Drive, Dropbox or iCloud folder through their OAuth. We store nothing.
2. **End-to-end encrypted relay.** Each device keeps a log of changes per row (the tables already use UUID ids, plus `createdAt`/`updatedAt`). Changes are encrypted with a key derived from a recovery phrase, and a relay that cannot read them passes them between devices. Conflicts are resolved with CRDT or last-write-wins per field. Candidate tools: Evolu, Jazz, cr-sqlite, or Automerge/Yjs.
3. **Bank sync with Plaid — implemented**, see below.

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
- `npm run test:bank`: Plaid bank linking end to end (21 steps, see below).

## Optional bank linking (Plaid, read-only)

Designed for **personal use on Plaid's free Trial plan**. Off by default: without the env vars below the Bank page
shows "not configured" and everything else works as before.

### Privacy model
- **No central database, still.** `api/plaid/*.mjs` are thin Vercel Functions that hold `PLAID_CLIENT_ID` /
  `PLAID_SECRET`, forward one request to Plaid, return a minimised response to your device, and keep nothing (no DB,
  no files, no KV, no caches). Financial data is in the function's memory only for the duration of the request.
- **Nothing sensitive is logged.** The functions log only coarse events — `rejected` (route, reason, salted+truncated
  IP hash), `plaid_error` (route, Plaid `error_code`, `request_id`) — never tokens, keys, bodies, merchants, amounts or
  balances. Tokens travel in POST bodies (never URLs), so they don't appear in Vercel's request logs either.
- **Access tokens live on your devices.** After Link, the `access_token` is returned to the browser and stored in
  `link_item.accessTokenEnc`, sealed with a random **non-extractable** AES-GCM device key kept in IndexedDB. It leaves
  the device only inside your passphrase-encrypted backup or the E2E-encrypted Drive sync (re-sealed with the other
  device's key on arrival), so a second device can sync the same bank without re-linking (no extra Trial slot). Each
  sync request sends it over HTTPS; the function forwards it to Plaid and drops it.
- **Owner-only gate.** The site is public and the Trial cap is tiny, so every `/api/plaid/*` call (except the data-free
  `GET /api/plaid/status`) must carry `X-Open-Mint-Key: $OPEN_MINT_API_KEY`. You enter the key once per device (stored
  in that browser only). Wrong keys → 401; 10 bad keys from one client in 15 min → 429 lockout; >120 requests/min
  → 429. (Limits are per warm function instance — best-effort, which is fine because the key is the real gate.)
- **Read-only.** Only the `transactions` product is requested (balances come from `/accounts/get`). Nothing can move money.
- The service worker never caches `/api/*` or `*.plaid.com`.

### What it does
- **Link a bank** (official Plaid Link script `link-initialize.js`, countries US + CA, up to 730 days of history).
  Before linking, the app shows how many of the **10 lifetime Trial connections** have been used (counting removed
  ones — Plaid doesn't give slots back) and warns if you're re-linking a bank that's already connected.
- **Sync**: cursor-based `/transactions/sync`, all pages fetched then applied atomically with the new cursor
  (restarts on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`). Runs on **Sync now** and automatically on app open
  at most once every 4 h. Bank rows go into the normal `txn` table with `source='bank'` and a unique `externalId`
  (Plaid `transaction_id`) → re-syncs never duplicate. **Pending → posted**: the pending row is re-keyed to the posted
  id (same local row, your edits kept). **Removed** → tombstone. Plaid sign convention is kept (outflow positive = spend,
  inflow negative = income).
- **Categories**: Plaid `personal_finance_category` → Open Mint categories via a mapping table (`src/lib/plaid-map.ts`;
  e.g. `FOOD_AND_DRINK_GROCERIES`→Groceries, `INCOME`→Income, transfers and credit-card payments → a *Transfers*
  category that is excluded from spending/income). **Rules** (Bank page): "merchant contains X → category" beat the
  table on import and can be applied to past imports. Editing a bank transaction marks it `userEdited`, so later syncs
  never overwrite your merchant/category.
- **Errors**: `ITEM_LOGIN_REQUIRED` & friends mark the connection *Login required* with a **Reconnect** button
  (Link update mode — no new Item). **Remove** revokes the Item at Plaid (`/item/remove`), keeps imported transactions,
  and warns that it does not free a Trial slot.
- **Dashboard**: account balances and a simple net worth (depository/investment = assets, credit/loan = liabilities).
- **Sync/backup**: new tables `link_item`, `bank_account`, `category_rule` (migration v2) merge per record (LWW +
  tombstones); two devices importing the same bank transaction collapse to one row by `externalId`.

### Setup (owner)
1. Sign up at <https://dashboard.plaid.com/signup> (US/CA). New accounts created on/after 2026-04-15 get the free
   **Trial** plan: real bank data, max **10 Items for the lifetime of the account**. (Or use the **Sandbox** environment
   for fake data — unlimited, test credentials `user_good` / `pass_good`.)
2. Dashboard → **Developers → Keys**: copy your `client_id` and the **secret** for the environment you'll use
   (Sandbox secret or Production secret; the Trial plan runs on Plaid's **Production** environment, so use `PLAID_ENV=production` for real banks).
3. Pick a long random API key for yourself, e.g. `openssl rand -base64 32`.
4. Set the env vars on Vercel (Production) and redeploy:
   ```bash
   vercel env add PLAID_CLIENT_ID production      # paste client_id
   vercel env add PLAID_SECRET production         # paste the secret (sandbox or production)
   vercel env add PLAID_ENV production            # "sandbox" or "production"
   vercel env add OPEN_MINT_API_KEY production    # paste your random key
   vercel deploy --prod
   ```
   Locally: put the same names in `.env.local`-style env and run `npm run build && npm run start:api`.
5. Open **Bank** in the app, enter the API key once per device, then **Link a bank**.

**OAuth banks (optional).** Many US banks (Chase, Wells Fargo, …) use OAuth. Desktop browsers usually work without
extra setup (Link opens the bank in a popup). For mobile/PWA flows, set `PLAID_REDIRECT_URI=https://<your-domain>/bank/oauth/`,
add the same URL under Dashboard → **Developers → API → Allowed redirect URIs**, and redeploy; the `/bank/oauth/` page resumes Link.
On the Trial plan almost all OAuth institutions are available immediately; the dashboard OAuth registration is only required after upgrading to a paid plan.

### Bank tests
`npm run test:unit` covers mapping, rules, dedupe, pending→posted, removed and the merge of bank tables.
`npm run test:bank` runs the real `api/` functions (via `scripts/local-server.mjs`) against a mock Plaid server
(`scripts/mock-plaid.mjs`) with Plaid Link stubbed, in real Chromium: not-configured state, API-key gate/lockout/rate
limit, link → paginated import → balances, sealed token at rest, idempotent re-sync, pending→posted with a user edit,
removed, rules, ITEM_LOGIN_REQUIRED → Reconnect (update mode), dashboard net worth, throttled auto-sync, token
portability via encrypted backup and via E2E Drive sync (no duplicates), remove item, and a scan of all server output for
tokens/keys/secrets/merchant names.
