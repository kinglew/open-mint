// Minimal mock of the Plaid API endpoints Open Mint uses, for automated tests only.
// Control: POST /__control {action, ...}; GET /__state.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export const MOCK_CLIENT_ID = "mock-client-id";
export const MOCK_SECRET = "mock-secret-DO-NOT-LOG";

export function startMockPlaid(port, { today }) {
  const state = { items: new Map(), calls: [], publicTokens: [], accessTokens: [], pageSize: 2 };
  const day = (d = 0) => { const x = new Date(today + "T12:00:00"); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); };
  const pfc = (primary, detailed) => ({ primary, detailed: detailed || primary + "_OTHER" });
  const T = (id, name, amount, cat, extra = {}) => ({ transaction_id: id, account_id: "acc-chq", amount, iso_currency_code: "USD", date: day(1), authorized_date: day(1), name: name.toUpperCase(), merchant_name: name, pending: false, pending_transaction_id: null, personal_finance_category: cat, category: ["legacy"], location: { address: "123 Secret St" }, ...extra });
  function newItem() {
    const it = { item_id: "item-" + randomUUID().slice(0, 8), error: null, events: [], accounts: [
      { account_id: "acc-chq", name: "Plaid Checking", official_name: "Plaid Gold Checking", mask: "0000", type: "depository", subtype: "checking", balances: { current: 1200.5, available: 1100, iso_currency_code: "USD", limit: null } },
      { account_id: "acc-cc", name: "Plaid Credit Card", official_name: null, mask: "3333", type: "credit", subtype: "credit card", balances: { current: 300.25, available: 4699.75, iso_currency_code: "USD", limit: 5000 } },
    ] };
    for (const t of [
      T("txn-wholefoods", "Whole Foods", 54.2, pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_GROCERIES")),
      T("txn-pend-coffee", "Blue Bottle Coffee", 4.75, pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"), { pending: true, date: day(0) }),
      T("txn-payroll", "ACME Payroll", -2500, pfc("INCOME", "INCOME_WAGES")),
      T("txn-ccpay", "Credit Card Payment", 300, pfc("LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT")),
      T("txn-netflix", "Netflix", 15.99, pfc("ENTERTAINMENT", "ENTERTAINMENT_TV_AND_MOVIES")),
    ]) it.events.push({ kind: "added", t });
    return it;
  }
  const find = (tok) => state.items.get(tok);
  const err = (res, status, type, code, msg) => json(res, status, { error_type: type, error_code: code, error_message: msg, display_message: null, request_id: "req-" + randomUUID().slice(0, 6) });
  function json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/__state") return json(res, 200, { calls: state.calls, accessTokens: state.accessTokens, publicTokens: state.publicTokens, items: [...state.items.values()].map((i) => ({ item_id: i.item_id, error: i.error, events: i.events.length })) });
    if (path === "/__control") {
      const it = [...state.items.values()][0];
      if (body.action === "post_pending") { it.events.push({ kind: "removed", id: "txn-pend-coffee" }); it.events.push({ kind: "added", t: T("txn-posted-coffee", "Blue Bottle Coffee", 5.25, pfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"), { pending_transaction_id: "txn-pend-coffee" }) }); }
      if (body.action === "remove") it.events.push({ kind: "removed", id: body.id });
      if (body.action === "add") it.events.push({ kind: "added", t: T(body.id, body.name, body.amount, pfc(body.primary || "GENERAL_MERCHANDISE", body.detailed)) });
      if (body.action === "modify") it.events.push({ kind: "modified", t: T(body.id, body.name, body.amount, pfc(body.primary || "GENERAL_MERCHANDISE", body.detailed)) });
      if (body.action === "error") it.error = body.code || null;
      if (body.action === "balance") it.accounts[0].balances.current = body.current;
      return json(res, 200, { ok: true });
    }
    if (body.client_id !== MOCK_CLIENT_ID || body.secret !== MOCK_SECRET) return err(res, 400, "INVALID_INPUT", "INVALID_API_KEYS", "invalid client_id or secret provided");
    state.calls.push(path);
    switch (path) {
      case "/link/token/create": {
        if (!body.user?.client_user_id || !body.country_codes?.includes("US") || !body.country_codes?.includes("CA")) return err(res, 400, "INVALID_REQUEST", "INVALID_FIELD", "bad link token request");
        if (body.access_token) { const it = find(body.access_token); if (!it) return err(res, 400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "bad token"); it.error = null; }
        else if (!body.products?.includes("transactions")) return err(res, 400, "INVALID_REQUEST", "INVALID_FIELD", "products");
        return json(res, 200, { link_token: (body.access_token ? "link-update-" : "link-sandbox-") + randomUUID(), expiration: new Date(Date.now() + 4 * 3600e3).toISOString(), request_id: "r" });
      }
      case "/item/public_token/exchange": {
        if (!/^public-sandbox-/.test(body.public_token || "")) return err(res, 400, "INVALID_INPUT", "INVALID_PUBLIC_TOKEN", "bad public token");
        state.publicTokens.push(body.public_token);
        const tok = "access-sandbox-" + randomUUID();
        const it = newItem();
        state.items.set(tok, it); state.accessTokens.push(tok);
        return json(res, 200, { access_token: tok, item_id: it.item_id, request_id: "r" });
      }
      case "/transactions/sync": {
        const it = find(body.access_token);
        if (!it) return err(res, 400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "bad token");
        if (it.error) return err(res, 400, "ITEM_ERROR", it.error, "the login details of this item have changed");
        const from = body.cursor ? Number(Buffer.from(body.cursor, "base64").toString().split(":")[1]) : 0;
        const slice = it.events.slice(from, from + state.pageSize);
        const next = from + slice.length;
        return json(res, 200, {
          added: slice.filter((e) => e.kind === "added").map((e) => e.t),
          modified: slice.filter((e) => e.kind === "modified").map((e) => e.t),
          removed: slice.filter((e) => e.kind === "removed").map((e) => ({ transaction_id: e.id })),
          next_cursor: Buffer.from("cur:" + next).toString("base64"), has_more: next < it.events.length, accounts: it.accounts, request_id: "r",
        });
      }
      case "/accounts/get": case "/accounts/balance/get": {
        const it = find(body.access_token);
        if (!it) return err(res, 400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "bad token");
        if (it.error) return err(res, 400, "ITEM_ERROR", it.error, "login required");
        return json(res, 200, { accounts: it.accounts, item: { item_id: it.item_id, institution_id: "ins_109508", error: null }, request_id: "r" });
      }
      case "/item/remove": {
        if (!find(body.access_token)) return err(res, 400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "bad token");
        state.items.delete(body.access_token);
        return json(res, 200, { request_id: "r" });
      }
    }
    return err(res, 404, "INVALID_REQUEST", "NOT_FOUND", "unknown endpoint " + path);
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, state })));
}
