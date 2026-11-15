// POST /api/plaid/accounts — account list + balances. Default /accounts/get (balances cached by Plaid, no extra
// product); realtime:true uses /accounts/balance/get (live balance check, separately billed outside the Trial).
import { guarded, need, plaid, slimAccount } from "../_lib/plaid.mjs";

export const POST = guarded("accounts", async (body, cfg) => {
  const r = await plaid(cfg, body.realtime ? "/accounts/balance/get" : "/accounts/get", { access_token: need(body, "access_token") });
  return {
    accounts: (r.accounts || []).map(slimAccount),
    item: { item_id: r.item?.item_id, institution_id: r.item?.institution_id ?? null, error: r.item?.error?.error_code ?? null },
  };
});
