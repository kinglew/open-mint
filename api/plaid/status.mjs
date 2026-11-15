// GET /api/plaid/status — public, data-free: is bank linking configured on this deployment?
import { config, json } from "../_lib/plaid.mjs";

export function GET() {
  const c = config();
  return json(200, { configured: c.configured, env: c.configured ? c.env : null, oauthRedirect: c.configured ? !!c.redirectUri : false });
}
