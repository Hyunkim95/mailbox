import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AppStore } from "../src/app-store.ts";
import { AppService } from "../src/app-service.ts";
import { PayPal } from "../src/paypal.ts";
import { catalogue } from "../src/catalogue.ts";
import type { AskIntent, interpretAsk } from "../src/ai.ts";
import {
  Merchant,
  createMerchantHttp,
  MerchantError,
  type VerifiedCapture,
} from "@mailbox/service-sdk";

async function fixture(
  options: {
    loseFirstResponse?: boolean;
    interpret?: typeof interpretAsk;
  } = {},
) {
  let instant = "2026-11-11T12:00:00Z";
  const now = () => new Date(instant);
  const merchant = new Merchant(":memory:", catalogue.services, "maya", now);
  const captures = new Map<string, VerifiedCapture>(),
    orders = new Map<string, Record<string, unknown>>();
  let charges = 0,
    lost = false;
  const token = "test-mcp-key-more-than-32-characters",
    admin = "test-admin-key-more-than-32-characters";
  const server = createMerchantHttp({
    merchant,
    token,
    adminToken: admin,
    verifyCapture: async (id) => {
      const capture = captures.get(id);
      if (!capture)
        throw new MerchantError("CAPTURE_UNVERIFIED", "Unknown test capture.");
      return capture;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const values: Record<string, string> = {
    MOCK_MERCHANT_URL: `http://127.0.0.1:${address.port}`,
    MOCK_MERCHANT_TOKEN: token,
    MOCK_ADMIN_TOKEN: admin,
    PAYPAL_CLIENT_ID: "fixture-client",
    PAYPAL_CLIENT_SECRET: "fixture-secret",
    PAYPAL_MERCHANT_ID: catalogue.services[0]!.paypalMerchant,
    AGENTMAIL_API_KEY: "fixture-key",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    assert(url.startsWith("https://api-m.sandbox.paypal.com/"));
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "fixture-access" });
    if (url.endsWith("/v2/checkout/orders") && init?.method === "POST") {
      const key = (init.headers as Record<string, string>)["PayPal-Request-Id"];
      assert(key);
      const payload = JSON.parse(String(init.body)),
        unit = payload.purchase_units[0];
      let order = orders.get(key);
      if (!order) {
        charges++;
        const id = `ORDER-${charges}`,
          captureId = `CAPTURE-${charges}`;
        captures.set(captureId, {
          id: captureId,
          invoice_id: unit.invoice_id,
          amount_minor: Math.round(Number(unit.amount.value) * 100),
          currency: "USD",
          merchant_id: catalogue.services[0]!.paypalMerchant,
        });
        order = {
          id,
          status: "COMPLETED",
          purchase_units: [
            {
              ...unit,
              payments: {
                captures: [
                  { id: captureId, status: "COMPLETED", amount: unit.amount },
                ],
              },
            },
          ],
        };
        orders.set(key, order);
      }
      if (options.loseFirstResponse && !lost) {
        lost = true;
        throw new TypeError("Simulated response lost after provider capture");
      }
      // Deliberately return PayPal's minimal response. The consumer must GET the order.
      return Response.json({ id: order.id, status: order.status });
    }
    if (url.includes("/v2/checkout/orders/")) {
      const id = url.split("/").at(-1);
      const order = [...orders.values()].find((o) => o.id === id);
      assert(order);
      return Response.json(order);
    }
    throw new Error(
      `Unexpected fixture provider request: ${new URL(url).pathname}`,
    );
  };
  const store = new AppStore(
    ":memory:",
    now,
    "integration-vault-key-at-least-32-characters",
  );
  const app = new AppService(
    store,
    new PayPal(request),
    {
      provisionAddress: async (_store, wallet) => wallet,
      deliverOutbox: async () => {},
      syncInbox: async () => {},
    },
    options.interpret,
  );
  const wallet = store.ensureWallet(
    "owner",
    catalogue.services.find((s) => s.id === "coast-screen")!,
  );
  wallet.mode = "ask";
  wallet.vault_id = "fixture-vault-token";
  wallet.email = "coast@example.test";
  wallet.inbox_id = "fixture-inbox";
  store.saveWallet(wallet);
  return {
    store,
    app,
    merchant,
    wallet,
    charges: () => charges,
    advanceTo: (value: string) => {
      instant = value;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      merchant.close();
      store.close();
      for (const key of Object.keys(values)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    },
  };
}

test("model-backed film lookup uses the grounded title even when its general query is the whole request", async () => {
  const intent: AskIntent = {
    intent: "film",
    query: "I want to watch The Lantern Coast",
    film_title: "The Lantern Coast",
    service_id: null,
    answer: null,
    date: null,
    time: null,
    party_size: null,
    quantity: 1,
    under_minor: null,
  };
  const f = await fixture({ interpret: async () => intent });
  try {
    const found = await f.app.ask("owner", "I want to watch The Lantern Coast");
    assert.equal(found.type, "options");
    assert("options" in found);
    assert.deepEqual(
      found.options.map((option) => option.id),
      ["harbor-play", "lantern-cinema", "coast-screen"],
    );
    assert.equal(f.charges(), 0);
    intent.film_title = "A Film Not In This Catalogue";
    const absent = await f.app.ask("owner", "I want a different film");
    assert.equal(absent.type, "answer");
    assert(
      "answer" in absent && /No supported fixture service/.test(absent.answer),
    );
    intent.film_title = null;
    const missing = await f.app.ask("owner", "I want to watch a film");
    assert("answer" in missing && /Which film/.test(missing.answer));
    assert.equal(f.store.proposals("owner").length, 0);
  } finally {
    await f.close();
  }
});
test("consumer proposal uses real MCP, minimal PayPal response, independent merchant verification and one ledger debit", async () => {
  const f = await fixture();
  try {
    const proposal = await f.app.propose("owner", "coast-screen", "subscribe");
    const result = await f.app.approve("owner", proposal.id);
    assert.equal(result.type, "proposal");
    const paid = f.store.proposal("owner", proposal.id);
    assert.equal(paid.status, "PAID");
    assert.equal(paid.capture_id, "CAPTURE-1");
    assert.equal(paid.cancel_effective_at, "2026-12-11T12:00:00.000Z");
    assert.equal(
      f.store.publicWallet("owner", f.store.wallet("owner", f.wallet.id)).spent,
      799,
    );
    assert.equal(
      f.store.publicWallet("owner", f.store.wallet("owner", f.wallet.id))
        .reserved,
      0,
    );
    assert.equal(f.merchant.outbox().length, 1);
    assert.equal(
      f.store.messages("owner").length,
      0,
      "queued email is not claimed as received",
    );
    await f.app.approve("owner", proposal.id);
    assert.equal(f.charges(), 1);
    assert.equal(
      f.store.audit("owner").filter((e) => e.action === "PAYMENT_COMPLETED")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
test("lost provider response retains reservation and retries the same payment identity", async () => {
  const f = await fixture({ loseFirstResponse: true });
  try {
    const proposal = await f.app.propose("owner", "coast-screen", "subscribe");
    await f.app.approve("owner", proposal.id);
    assert.equal(f.store.proposal("owner", proposal.id).status, "RECONCILING");
    assert.equal(
      f.store.publicWallet("owner", f.store.wallet("owner", f.wallet.id))
        .reserved,
      799,
    );
    assert.equal(f.charges(), 1);
    const paid = await f.app.pay("owner", proposal.id);
    assert.equal(paid.status, "PAID");
    assert.equal(f.charges(), 1);
    assert.equal(f.merchant.outbox().length, 1);
    assert.equal(
      f.store.publicWallet("owner", f.store.wallet("owner", f.wallet.id))
        .available,
      1201,
    );
  } finally {
    await f.close();
  }
});
test("two approved proposals cannot charge twice for the same active subscription", async () => {
  const f = await fixture();
  try {
    const first = await f.app.propose("owner", "coast-screen", "subscribe");
    const second = await f.app.propose("owner", "coast-screen", "subscribe");
    await f.app.approve("owner", first.id);
    await assert.rejects(f.app.approve("owner", second.id), /already.*access/i);
    assert.equal(f.charges(), 1);
    assert.equal(f.merchant.outbox().length, 1);
  } finally {
    await f.close();
  }
});
test("a canceled historical subscription cannot mark a new paid month canceled", async () => {
  const f = await fixture();
  try {
    const first = await f.app.propose("owner", "coast-screen", "subscribe");
    await f.app.approve("owner", first.id);
    f.advanceTo("2026-12-12T12:00:00Z");
    f.merchant.settleDue();
    const wallet = f.store.wallet("owner", f.wallet.id);
    wallet.expires_at = "2027-01-15T12:00:00Z";
    f.store.saveWallet(wallet);
    const second = await f.app.propose("owner", "coast-screen", "subscribe");
    await f.app.approve("owner", second.id);
    await f.app.sync("owner");
    assert.equal(f.charges(), 2);
    assert.equal(f.store.proposal("owner", second.id).status, "PAID");
    assert.notEqual(f.store.wallet("owner", f.wallet.id).status, "canceled");
  } finally {
    await f.close();
  }
});
test("coffee and dining execute exact paid actions through the consumer orchestrator", async () => {
  const f = await fixture();
  try {
    for (const serviceId of ["basil-market", "marina-table"]) {
      const wallet = f.store.ensureWallet(
        "owner",
        catalogue.services.find((s) => s.id === serviceId)!,
      );
      wallet.mode = "ask";
      wallet.vault_id = "fixture-vault-token";
      wallet.email = `${serviceId}@example.test`;
      f.store.saveWallet(wallet);
      const proposal = await f.app.propose(
        "owner",
        serviceId,
        serviceId === "marina-table" ? "book" : "buy",
        serviceId === "marina-table"
          ? { booking: { date: "2026-11-13", time: "19:00", party_size: 2 } }
          : {},
      );
      await f.app.approve("owner", proposal.id);
      const paid = f.store.proposal("owner", proposal.id);
      assert.equal(paid.status, "PAID");
      assert.equal(paid.amount, serviceId === "marina-table" ? 1000 : 650);
      assert.equal(
        f.merchant.status(serviceId, paid.merchant_action_id!).status,
        "CONFIRMED",
      );
    }
    assert.equal(f.charges(), 2);
    assert.equal(f.merchant.outbox().length, 2);
  } finally {
    await f.close();
  }
});
test("an approved pet-food rule uses a strict threshold and fires exactly once", async () => {
  const f = await fixture();
  try {
    const wallet = f.store.ensureWallet(
      "owner",
      catalogue.services.find((s) => s.id === "daily-paws")!,
    );
    wallet.mode = "auto";
    wallet.auto_under = 3000;
    wallet.vault_id = "fixture-vault-token";
    wallet.email = "pets@example.test";
    f.store.saveWallet(wallet);
    const equal = await f.app.propose("owner", "daily-paws", "condition", {
      under: 2999,
    });
    await f.app.approve("owner", equal.id);
    await f.app.evaluateConditions("owner");
    assert.equal(f.store.proposal("owner", equal.id).status, "WAITING");
    assert.equal(f.charges(), 0);
    f.app.decline("owner", equal.id);
    const qualifying = await f.app.propose("owner", "daily-paws", "condition", {
      under: 3000,
    });
    await f.app.approve("owner", qualifying.id);
    await f.app.evaluateConditions("owner");
    await f.app.evaluateConditions("owner");
    const paid = f.store.proposal("owner", qualifying.id);
    assert.equal(paid.status, "PAID");
    assert.equal(paid.item_id, "dog-food-3kg");
    assert.equal(paid.amount, 2999);
    assert.equal(f.charges(), 1);
    assert.equal(f.merchant.outbox().length, 1);
  } finally {
    await f.close();
  }
});
test("wallet pause during provider work survives payment completion", async () => {
  const f = await fixture();
  try {
    const proposal = await f.app.propose("owner", "coast-screen", "subscribe");
    const original = f.app.paypal.createOrder.bind(f.app.paypal);
    f.app.paypal.createOrder = async (...args) => {
      const order = await original(...args);
      f.app.pause("owner", f.wallet.id, true);
      return order;
    };
    await f.app.approve("owner", proposal.id);
    assert.equal(f.store.proposal("owner", proposal.id).status, "PAID");
    assert.equal(
      f.store.wallet("owner", f.wallet.id).paused,
      true,
      "completion cannot restore a stale unpaused wallet",
    );
  } finally {
    await f.close();
  }
});
test("pause during token exchange cannot resurrect permission or dispatch a payment", async () => {
  const now = () => new Date("2026-11-11T12:00:00Z"),
    store = new AppStore(
      ":memory:",
      now,
      "token-exchange-test-secret-long-enough",
    );
  const previous = process.env.PAYPAL_CLIENT_ID,
    previousSecret = process.env.PAYPAL_CLIENT_SECRET;
  process.env.PAYPAL_CLIENT_ID = "fixture";
  process.env.PAYPAL_CLIENT_SECRET = "fixture";
  try {
    const wallet = store.ensureWallet(
      "owner",
      catalogue.services.find((s) => s.id === "coast-screen")!,
    );
    wallet.mode = "ask";
    store.saveWallet(wallet);
    const paypal = new PayPal(),
      app = new AppService(store, paypal);
    let deleted = false;
    paypal.exchange = async () => {
      app.pause("owner", wallet.id, true);
      return "new-test-token";
    };
    paypal.removeToken = async () => {
      deleted = true;
      return {};
    };
    const state = store.createSetup("owner", {
      wallet_id: wallet.id,
      proposal_id: "not-needed",
      setup_id: "setup-id",
      revision: wallet.revision,
      created_at: now().toISOString(),
    });
    await assert.rejects(app.finishSetup("owner", state), /permission changed/);
    assert.equal(store.wallet("owner", wallet.id).paused, true);
    assert.equal(store.wallet("owner", wallet.id).vault_id, null);
    assert.equal(deleted, true);
  } finally {
    store.close();
    if (previous === undefined) delete process.env.PAYPAL_CLIENT_ID;
    else process.env.PAYPAL_CLIENT_ID = previous;
    if (previousSecret === undefined) delete process.env.PAYPAL_CLIENT_SECRET;
    else process.env.PAYPAL_CLIENT_SECRET = previousSecret;
  }
});
