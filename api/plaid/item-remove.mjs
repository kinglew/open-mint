// POST /api/plaid/item-remove — revokes the access_token at Plaid. (On the Trial plan this does NOT free a slot.)
import { guarded, need, plaid } from "../_lib/plaid.mjs";

export const POST = guarded("item-remove", async (body, cfg) => {
  await plaid(cfg, "/item/remove", { access_token: need(body, "access_token") });
  return { removed: true };
});
