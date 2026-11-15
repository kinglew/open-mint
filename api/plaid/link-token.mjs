// POST /api/plaid/link-token — creates a Plaid Link token (new link, or update mode when access_token is given).
import { guarded, need, plaid } from "../_lib/plaid.mjs";

export const POST = guarded("link-token", async (body, cfg) => {
  const clientUserId = need(body, "client_user_id");
  const req = {
    client_name: "Open Mint",
    language: "en",
    country_codes: ["US", "CA"],
    user: { client_user_id: clientUserId },
  };
  if (body.access_token != null) {
    req.access_token = need(body, "access_token"); // update mode (re-authenticate an existing Item)
  } else {
    req.products = ["transactions"];
    req.transactions = { days_requested: 730 };
  }
  if (cfg.redirectUri) req.redirect_uri = cfg.redirectUri;
  const r = await plaid(cfg, "/link/token/create", req);
  return { link_token: r.link_token, expiration: r.expiration };
});
