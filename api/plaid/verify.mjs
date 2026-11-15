// POST /api/plaid/verify — checks the owner API key (used by the Bank page before saving it).
import { guarded } from "../_lib/plaid.mjs";

export const POST = guarded("verify", async (_body, cfg) => ({ ok: true, env: cfg.env }));
