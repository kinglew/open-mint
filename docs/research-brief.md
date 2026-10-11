# Reimplementing Classic Intuit Mint — Research & Planning Analysis

**Audience:** Captain / Firstmate decision-makers  
**Scope:** Research and planning only (no scaffolding)  
**Default product posture:** Progressive Web App (PWA), US-first, read-only aggregation before any money movement  
**Report date:** 2026-09-28 (America/Toronto)  
**Status of Mint:** Discontinued (shut down March 23, 2024)

---

## Sources (web-verified)

| Topic | Primary / secondary sources |
| --- | --- |
| Mint shutdown & features | [Wikipedia — Intuit Mint](https://en.wikipedia.org/wiki/Intuit_Mint); [PCMag Mint review (2023)](https://uk.pcmag.com/first-looks/135509/mint); [CNBC Make It (Nov 2023)](https://www.cnbc.com/2023/11/07/budgeting-app-mint-is-shutting-down-users-are-disappointed.html) |
| Plaid products & billing | [Plaid Docs](https://plaid.com/docs/); [Plaid pricing & billing](https://plaid.com/docs/account/billing/); [Plaid Help — plans](https://support.plaid.com/hc/en-us/articles/16110502116887-What-are-Plaid-s-prices-and-pricing-plans-and-how-do-they-differ); [Sandbox vs Trial vs Production](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different) |
| MX | [MX Account Aggregation](https://www.mx.com/products/account-aggregation/); [MX Connectivity Overview](https://docs.mx.com/products/connectivity/overview) |
| Finicity / Mastercard Open Finance | [Mastercard Open Finance US — PFM use case](https://developer.mastercard.com/open-finance-us/documentation/usecases/personal-finance-management/); industry comparisons (pricing not public) |
| US open banking / §1033 | [CRS IF13117](https://www.congress.gov/crs-product/IF13117); [Moore & Van Allen summary of injunction](https://mvalaw.com/data-points/cfpb-enjoined-from-enforcing-personal-financial-data-rights-rule-1033); [Open Banking Tracker — §1033 status](https://www.openbankingtracker.com/guides/section-1033-status) |
| Privacy / security posture | [FTC Safeguards Rule guide](https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know) |

**Uncertainty flag:** Exact dollar rates for MX, Finicity, and most Plaid SKUs are **not public**. Third-party blogs quote ranges; treat those as unverified directional signals only. Institution coverage counts also differ by vendor marketing vs independent audits—cite as claims, not audited facts.

---

## 1. Classic Mint feature teardown

Classic Mint (defunct **March 23, 2024**; originally announced for end of 2023, then extended) was a free/ad-supported PFM that aggregated bank, card, investment, and loan data; auto-categorized transactions; powered budgets/goals/net worth/trends; tracked bills; and showed a TransUnion VantageScore. Bill *payment* via Mint Bills ended earlier (June 30, 2018). Users were steered to Credit Karma; many reported budgets/custom categories did not fully carry over.

Sources: [Wikipedia](https://en.wikipedia.org/wiki/Intuit_Mint), [PCMag](https://uk.pcmag.com/first-looks/135509/mint), [CNBC](https://www.cnbc.com/2023/11/07/budgeting-app-mint-is-shutting-down-users-are-disappointed.html).

| Feature | MVP priority | Why |
| --- | --- | --- |
| **Manual expense / income entry** | **Must-have** | Phase-1 path without bank sync; still a complete budgeting loop |
| **Receipt camera → OCR → expense** | **Must-have** (Phase 1) | Substitutes for bank connect when aggregator onboarding is slow/blocked |
| **Category system (defaults + custom + recategorize)** | **Must-have** | Core of Mint UX; budgets are meaningless without categories |
| **Budgets by category (monthly targets, progress)** | **Must-have** | Primary reason users preferred Mint over Credit Karma post-migration |
| **Transaction list / history / search / edit** | **Must-have** | Foundation for everything else |
| **Accounts aggregation (bank, credit card)** | **Must-have** (Phase 2) | Classic Mint’s identity; defer only if aggregator access is the bottleneck |
| **Balances + simple net worth (linked accounts)** | **Must-have** (Phase 2) / Nice-to-have Phase 1 (manual net worth) | Users expect a dashboard “how am I doing?” number |
| **Alerts (budget overspend, bill due, sync errors)** | **Nice-to-have** early; Must-have by Phase 2 | Retention and trust; sync-error alerts critical once aggregation ships |
| **Bills / recurring detection (track, not pay)** | **Nice-to-have** | High perceived value; can start as manual recurring rules |
| **Goals (savings, debt payoff)** | **Nice-to-have** | Differentiator vs bare expense trackers; not required for first budget loop |
| **Trends / reports (spend, income, net worth charts)** | **Nice-to-have** | PCMag called Trends Mint’s best web feature; Phase 1.5+ |
| **Investments (holdings + investment txns)** | **Defer** for MVP | Mint itself was weak here; needs Investments product + more UX |
| **Liabilities detail (mortgage/student loan terms)** | **Defer** | Useful for net worth depth; not needed for spending budgets |
| **Credit score / credit monitoring** | **Defer / skip** early | Requires bureau partnership (Mint used TransUnion Vantage 3.0); separate vendor, privacy, and monetization path |
| **Property / vehicle asset valuation** | **Defer / skip** | Third-party data; peripheral to budgeting MVP |
| **Bill negotiation / subscription cancel concierge** | **Skip** | Ops-heavy; was Premium/partner territory |
| **Bill pay / money movement / ACH** | **Skip** (explicitly) | Triggers KYC, money-transmitter, ACH risk; out of scope for read-only rebuild |
| **Marketplace / product referrals / ads** | **Defer** | Mint’s monetization; decide only after product-market fit |
| **CSV import (Mint/Quicken exports)** | **Nice-to-have** Phase 0–1 | Helps migrants with old Mint CSVs; low build cost, high goodwill |

### Teardown takeaway

Ship a **credible budget + expense loop** first (manual + OCR). Treat **read-only bank sync** as Phase 2. Do **not** chase credit score, investments depth, or payments in the first year unless strategy explicitly changes.

---

## 2. Bank / aggregator landscape

### Comparison (US consumer PFM focus)

| Dimension | **Plaid** | **MX** | **Finicity (Mastercard Open Finance US)** |
| --- | --- | --- | --- |
| **Coverage posture** | Broad consumer/fintech default; strong DX and Link UX. Exact FI counts vary by source; treat marketing “10k+/12k+” figures as claims. | Emphasizes DDA coverage US/Canada, “75%+ direct connections,” tokenized lasting links ([MX product page](https://www.mx.com/products/account-aggregation/)). Strong enrichment/categorization reputation in industry writeups. | Broad US aggregation under Mastercard Open Finance; historically strong in **verification / lending** (VOA/VOIE) as well as PFM aggregation. |
| **Typical products useful to Mint-like PFM** | **Transactions**, **Balance**, **Liabilities**, **Investments**, **Auth**, **Identity**, **Enrich**, optional Assets/Statements ([Plaid docs](https://plaid.com/docs/)) | **Account Aggregation** (accounts + txns), Balance Checks, Account Owner ID, Extended History (~24 mo), Statements, IAV/microdeposits ([MX docs](https://docs.mx.com/products/connectivity/overview)). Built-in enhancement (merchant cleanup, 100+ categories). | Account aggregation / transactions / balances; investment & liability details in account models; Data Connect consent UX; historic transactions (docs reference multi-month history). PFM called out as a use case on Mastercard Open Finance docs. |
| **Developer access** | **Sandbox** free (mock data). **Trial** (US/CA teams created on/after **2026-04-15**): free real Production data, **cap 10 Items**, bundled core products, auto-approved for most. Full **Production** requires application (use-case review). Plans: Trial → Pay-as-you-go → Growth → Custom ([Plaid Help](https://support.plaid.com/hc/en-us/articles/16110110883479-How-are-Sandbox-Production-Trial-plan-and-Limited-Production-different)). | Docs/sandbox available; production typically **sales-led / contract**. Platform API with API keys, versioned Accept headers ([MX docs](https://docs.mx.com/products/connectivity/overview)). | Sandbox/eval on Mastercard Developers; **production requires commercial agreement** with Mastercard. No public self-serve rate card found. |
| **Known friction for a new consumer finance app** | Production use-case review; OAuth institution registration quirks; **subscription billing** on Transactions/Investments/Liabilities (ongoing cost per Item even if Item is broken unless removed); bank-side OAuth/consent UX changes; evolving bank↔aggregator fee deals as open banking economics shift. | Enterprise sales cycle; less “indie default” than Plaid; may overfit bank/credit-union wellness embeds vs pure consumer startup. | Enterprise/Mastercard sales motion; verification products may be priced/positioned for lenders more than ad-supported PFM; onboarding heavier than Plaid Trial. |
| **Rough pricing model (public facts only)** | **No public price list.** Models: one-time (Auth, Identity), **monthly subscription** (Transactions, Liabilities, Investments), per-request (Balance, refresh endpoints), flexible (Assets, Enrich). Trial free ≤10 Items. Pay-as-you-go / Growth show prices in Production application flow; Custom for higher volume ([Plaid billing docs](https://plaid.com/docs/account/billing/)). | **Not publicly listed.** Industry blogs claim contract/volume tiers (often cited as multi‑thousand USD/month)—**unverified; do not budget from blogs alone.** | **Not publicly listed.** Often described as usage/event or contract-based via Mastercard sales—**unverified dollar amounts.** |

### Other major US options (brief)

| Provider | Note |
| --- | --- |
| **Envestnet Yodlee** | Long-tail aggregator; historically powered early Mint; enterprise-oriented. |
| **Akoya** | Bank-consortium / FDX-oriented API network; fewer institutions than scrapers but “API-native” posture. |
| **Teller** | Developer-friendly niche aggregator; smaller coverage; sometimes used for early prototypes. |
| **Stripe Financial Connections** | Useful if already in Stripe ecosystem; narrower PFM feature depth than full aggregators. |

### US open banking / data-access trends (high level — not legal advice)

- **Statute:** Dodd-Frank **Section 1033** directs covered institutions to make certain consumer financial data available upon request, with CFPB rulemaking ([CRS IF13117](https://www.congress.gov/crs-product/IF13117)).
- **2024 rule:** CFPB finalized a Personal Financial Data Rights rule (Oct 2024) with phased compliance originally aimed at **2026–2030**.
- **2025–2026 reality:** The rule is **under reconsideration** and a federal court (E.D. Kentucky) **enjoined enforcement** pending that reconsideration ([Moore & Van Allen](https://mvalaw.com/data-points/cfpb-enjoined-from-enforcing-personal-financial-data-rights-rule-1033); [Open Banking Tracker](https://www.openbankingtracker.com/guides/section-1033-status)). The first compliance tier date did **not** become a reliable enforcement trigger.
- **Market implication for builders:** Do **not** roadmap as if free, mandatory, stable third-party API access is guaranteed. Expect continued reliance on **aggregators**, FDX-style connections, bank OAuth, and **possible data-access fees** flowing through aggregator pricing. Watch rewritten §1033 text (including fee and “authorized third party” definitions) as it emerges.

**Captain decision:** Default Phase-2 aggregator recommendation is **Plaid** for speed-to-sandbox + Trial path; evaluate **MX** if categorization quality becomes the #1 churn driver after sync ships. Finicity is secondary unless lending/verification adjacency appears.

---

## 3. Regulatory & compliance (high level — not legal advice)

Assume **US consumer PFM, read-only aggregation first**. Engage counsel before production launch with real bank data. Categories to plan for:

| Category | Practical planning notes |
| --- | --- |
| **Data privacy / GLBA–FTC Safeguards** | Holding nonpublic personal financial information can pull a business into “financial institution” definitions under GLBA/FTC frameworks depending on activities. The **FTC Safeguards Rule** expects a written information security program: Qualified Individual, risk assessment, encryption, MFA, vendor oversight, incident response, breach notification thresholds, etc. ([FTC guide](https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know)). Even if counsel later opines a narrow exception applies, **building as if Safeguards-grade controls are required** is the safe engineering default. |
| **Consumer financial data rights trends (§1033)** | Unsettled (see §2). Design for **consumer consent, purpose limitation, easy disconnect/delete, and audit logs** of data access. Prefer aggregator OAuth over storing bank passwords (classic Mint credential-storage controversies are a cautionary tale). |
| **SOC 2 / security expectations** | Not legally mandatory by itself, but **aggregators, enterprise partners, and serious users** often expect SOC 2 Type II (or equivalent) before scale. Plan security program → policies → evidence collection early; certification can lag product MVP. |
| **KYC / CIP** | For **read-only** budgeting with no money movement: typically **not** bank-level KYC. Still verify email, use strong auth, abuse controls. If you later add transfers/payments/wallets, expect full CIP/KYC/AML stack. |
| **PCI DSS** | Avoid storing raw card PANs. Camera receipt OCR should **not** persist full card numbers; redact. If you never process payments, PCI scope stays minimal—confirm with QSA/counsel if any payment features appear. |
| **State money transmitter / payments** | **Out of scope** while read-only. Adding P2P, bill pay, or disbursements can trigger state MTL licensing, partner bank models, or BaaS—major timeline/cost spike. Explicitly cut from MVP. |
| **Credit data (FCRA)** | Soft-pull credit scores / bureau products bring **FCRA** and bureau contracts. Defer unless product strategy requires it. |
| **State privacy (CCPA/CPRA etc.)** | Consumer rights to access/delete/opt-out of sale/sharing; privacy policy; data inventory. Relevant once you have CA (and other state) users. |
| **Tax / advice disclaimers** | PFM is not fiduciary advice; clear product disclaimers; no “guaranteed savings” claims. |

**Practical Phase-0 security baseline (engineering):** encrypted DB at rest, TLS, secrets manager, MFA for users, least-privilege IAM, audit logs, retention/deletion policy, subprocessors list, no bank passwords stored locally.

---

## 4. Receipt OCR path (bank connect deferred)

### Goal

Let users photograph receipts → extract merchant, date, total, tax, line items (best effort) → map to **budget categories** → create expenses that feed the same ledger as manual entries. This is the Phase-1 substitute for live bank sync.

### On-device vs cloud OCR

| Approach | Pros | Cons | Fit for Mint-like PWA |
| --- | --- | --- | --- |
| **On-device** (e.g. platform Vision / ML Kit via Capacitor wrapper; or WASM Tesseract.js in browser) | Stronger **privacy** (image may never leave device); lower per-scan cloud cost; works offline | Accuracy weaker on crumpled/low-light receipts; PWA-only WASM is slower/heavier; native wrappers needed for best ML Kit/Vision | Prefer for privacy marketing; hybrid “OCR on device, store structured fields” |
| **Cloud** (Google Document AI, AWS Textract AnalyzeExpense, Veryfi, etc.) | Better structured receipt fields; less client compute | Image leaves device → privacy/policy/vendor DPA; per-page cost; latency; need retention controls | Fine if DPA + short retention + user consent; good accuracy path |
| **Hybrid** | On-device for text + PII redaction; cloud only for hard cases | More engineering | Recommended long-term |

### Privacy design

- Explicit consent before camera/upload.
- Prefer **ephemeral** image storage (process → discard); keep only structured expense fields + optional thumbnail.
- Redact PAN/CVV if detected; never log raw images in APM.
- Document subprocessors; allow user delete of receipt-derived expenses and any stored images.
- If cloud OCR: region pinning, retention SLA (e.g. delete image within N hours).

### Categorization into budgets

1. OCR → merchant name + MCC-ish guess + amount + date.  
2. **Rules engine:** user rules (“Whole Foods → Groceries”) + defaults from merchant DB.  
3. Optional lightweight ML later; start with rules + manual confirm UI (Mint-like “fix category”).  
4. Confirmed expense posts to `transactions` table with `source=ocr|manual|bank`.  
5. Budget rollups sum by category/month—**same code path** as bank-synced txns later.

### Plugging into MVP without live bank sync

```
Camera / file upload → OCR service → Review sheet (edit amount/category) → Save expense
                                                                      ↓
User + Categories + Budgets ←—— monthly aggregates ——→ Dashboard
Manual entry API  ————————————————————————————————————↗
```

- **Accounts** can be virtual (“Cash”, “Wallet”) until Phase 2.  
- **CSV import** can seed history for Mint migrants.  
- When Plaid/MX arrives, map external transactions into the **same** schema; OCR remains useful for cash and uncategorized edge cases.

---

## 5. Architecture options (PWA-first)

### Recommended stack sketch

| Layer | Suggestion | Notes |
| --- | --- | --- |
| **Frontend** | TypeScript + **Next.js** (App Router) or Vite + React; **PWA** via Workbox / Serwist | Installable, offline shell for recent expenses; camera via `getUserMedia` / file input |
| **UI** | Tailwind + accessible component library | Mobile-first; budget bars were Mint’s love language |
| **Backend** | Node (Nest/Fastify) or Python (FastAPI) on **Fly.io / Render / Cloud Run** | Start monolith API; extract workers later |
| **DB** | **PostgreSQL** (Neon/Supabase/RDS) | Accounts, transactions, categories, budgets, connections, audit_log |
| **Auth** | **Auth.js / Clerk / Supabase Auth** + MFA | Email magic link or OAuth; MFA before linking banks |
| **Object storage** | S3-compatible (R2/S3) | Short-lived receipt images only |
| **Jobs** | Queue (PgBoss / SQS) | OCR jobs, aggregator sync, webhook handlers |
| **Aggregator integration points** | Backend-only secrets; Link/Connect token exchange on server; store `item_id`/`member_guid` + encrypted access tokens; webhooks → sync worker → normalize → `transactions` | Never expose aggregator secrets to client |
| **OCR** | Interface `ReceiptParser`; impls: `OnDeviceStub`, `TextractExpense`, `DocumentAI` | Swap without rewriting budget logic |
| **Observability** | OpenTelemetry + error tracking | Especially sync failure rates |

### Schema sketch (conceptual)

- `users`, `categories`, `budgets` (user_id, category_id, month, amount)  
- `accounts` (manual | aggregated)  
- `transactions` (amount, date, merchant, category_id, source, external_id unique)  
- `connection_items` (aggregator, status, cursor, last_sync_error)  
- `receipts` (optional blob ref, parse_status, transaction_id)

### Alternatives (brief)

| Option | When |
| --- | --- |
| **Capacitor / Ionic wrapper** | Need App Store presence, better on-device OCR (Vision/ML Kit), push reliability |
| **React Native / Flutter** | If PWA camera/OCR quality is insufficient after spike; higher dual-platform cost |
| **BFF + serverless only** | Fine for Phase 0–1; watch cold starts on Link token exchange |

### Effort / risk order-of-magnitude (small team)

| Phase | Solo | 2–3 eng | Dominant risks |
| --- | --- | --- | --- |
| **0 — Research spike + design** | 2–4 weeks | 1–2 weeks | Over-scoping; picking aggregator before product loop works |
| **1 — Manual + OCR + budgets PWA** | ~2–4 months | ~6–10 weeks | OCR accuracy UX; retention without auto-import |
| **2 — Read-only aggregation** | +2–4 months | +6–12 weeks | Production access approval; sync reliability; categorization quality; unit economics per connected Item |
| **Hardening (SOC2 path, scale)** | Ongoing parallel | Ongoing | Compliance evidence lag; incident readiness |

*Figures are engineering calendar estimates for a greenfield small team, not commitments—adjust for part-time / design / legal.*

---

## 6. Phased MVP

### Phase 0 — Foundations (2–4 weeks)

**Deliverables**

- Product principles: read-only, PWA-first, US-only, privacy-by-default.  
- Threat model + data inventory draft; privacy policy outline.  
- UX flows: signup → categories → budget → add expense → receipt capture → review.  
- Aggregator **sandbox** spike (Plaid Link hello-world) *without* blocking Phase 1.  
- Decision log for Captain/Firstmate (see below).

**Cut**

- Native apps, credit score, investments, marketplace, bill pay.

**Biggest risks**

- Premature aggregator contracts; building sync before anyone budgets successfully.

---

### Phase 1 — Manual + OCR expenses + budgets (default first ship)

**Deliverables**

- Auth + MFA.  
- Category CRUD + defaults.  
- Manual transactions.  
- Budget targets + progress UI + basic overspend alert (email/push if easy).  
- Receipt capture → OCR → review → expense.  
- Simple dashboard (spend vs budget; optional manual net-worth fields).  
- CSV import (Mint-style columns) nice-to-have.  
- PWA installability + offline read of recent data.

**Cut**

- Live bank/credit sync; investments; credit score; bills automation beyond manual recurrings; multi-currency depth.

**Biggest risks**

- **Habit risk:** without auto-import, users churn—mitigate with OCR speed, widgets, daily reminder, frictionless manual add.  
- OCR error rates → always show review screen.  
- Underestimating Safeguards-style security work while “just” storing expense data.

---

### Phase 2 — Read-only aggregation

**Deliverables**

- Production aggregator onboarding (likely Plaid Pay-as-you-go/Growth after Trial).  
- Link/Connect UX; webhook-driven sync; duplicate detection; sync-error alerts.  
- Map bank txns into existing categories/budgets; merchant cleanup (Plaid Enrich and/or rules; consider MX if quality insufficient).  
- Multi-account balances + computed net worth.  
- Recurring/bill detection (heuristic).  
- Disconnect + data deletion flows.

**Cut (still)**

- Money movement, bill pay, credit bureau, heavy investment analytics, ads marketplace (unless monetization decision flips).

**Biggest risks**

- **Access & economics:** production approval delays; per-Item subscription costs; bank fee pass-through as §1033/fee landscape shifts.  
- Connection breakage / re-auth fatigue (classic Mint pain).  
- Categorization quality vs user expectations set by Mint/MX-class enrichment.  
- Security/compliance bar rises sharply with live bank data.

---

## Decisions needed from Captain / Firstmate

1. **Monetization:** free+ads (Mint-like), subscription (Monarch/Simplifi-like), or hybrid? Drives OCR cloud budget and aggregator willingness-to-pay.  
2. **Aggregator default:** commit to **Plaid-first** for Phase 2, or run parallel MX RFP?  
3. **OCR privacy stance:** on-device-first (marketing + engineering cost) vs cloud-first (speed/accuracy)?  
4. **Geography:** US-only at launch, or US+Canada (Mint footprint)?  
5. **Credit score:** permanently out of MVP, or partner evaluation in parallel?  
6. **Entity / counsel:** when to engage privacy/fintech counsel relative to first external beta.  
7. **App stores:** PWA-only for 12 months, or Capacitor wrapper once OCR quality is proven?

---

## Executive summary (for relay)

Intuit **shut down Mint on March 23, 2024** after steering users to Credit Karma; classic strengths were aggregation, auto-categorization, budgets, bills tracking, net worth/trends, and a basic credit score—not deep investing or bill pay (pay ended 2018). A rebuild should treat **budgets + categories + expenses** as the product heart, ship **manual + receipt OCR** before bank sync, and add **read-only aggregation** only when aggregator production access and unit economics are clear.

Among aggregators, **Plaid** offers the clearest self-serve path (Sandbox + US/CA **Trial ≤10 Items** post–Apr 15, 2026; paid plans without a public rate card). **MX** is strong on enrichment/DDA connectivity but sales-led. **Finicity/Mastercard Open Finance** fits verification-heavy and enterprise motions; pricing is opaque. US **§1033** open-banking rules are **finalized but enjoined/under reconsideration**—do not assume free mandatory access.

Compliance planning (not advice): GLBA/FTC Safeguards-grade security, consent/deletion, SOC 2 trajectory; defer KYC/MTL/PCI-heavy features by staying read-only and avoiding PAN storage.

Recommended PWA stack: React/Next PWA, Postgres, server-side aggregator Link, pluggable OCR. Phases: **0** foundations → **1** manual+OCR+budgets → **2** read-only sync. Largest risks: user habit without auto-import; aggregator approval/cost; sync reliability; categorization quality.

---

*End of report. No code was scaffolded per research-only mandate.*
