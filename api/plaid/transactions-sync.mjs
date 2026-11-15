// POST /api/plaid/transactions-sync — one page of /transactions/sync (cursor-based). The device loops while has_more.
import { guarded, need, plaid, slimAccount, slimTxn } from "../_lib/plaid.mjs";

export const POST = guarded("transactions-sync", async (body, cfg) => {
  const req = { access_token: need(body, "access_token"), count: 500 };
  if (body.cursor) req.cursor = need(body, "cursor", /^[\w\-+/=]{1,4096}$/);
  const r = await plaid(cfg, "/transactions/sync", req);
  return {
    added: (r.added || []).map(slimTxn),
    modified: (r.modified || []).map(slimTxn),
    removed: (r.removed || []).map((x) => x.transaction_id),
    next_cursor: r.next_cursor,
    has_more: !!r.has_more,
    accounts: (r.accounts || []).map(slimAccount),
  };
});
