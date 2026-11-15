// POST /api/plaid/exchange — swaps Link's public_token for an access_token, returned to the device (never stored here).
import { guarded, need, plaid } from "../_lib/plaid.mjs";

export const POST = guarded("exchange", async (body, cfg) => {
  const r = await plaid(cfg, "/item/public_token/exchange", { public_token: need(body, "public_token") });
  return { access_token: r.access_token, item_id: r.item_id };
});
