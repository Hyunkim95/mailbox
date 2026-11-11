import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppStore, periodKey } from "../src/app-store.ts";
import { AppService } from "../src/app-service.ts";
import type { Proposal, Wallet } from "../src/app-model.ts";
import { catalogue } from "../src/catalogue.ts";
import { createSession, ownerFromSession } from "../src/auth.ts";
import { PayPal } from "../src/paypal.ts";
import { MerchantError } from "@mailbox/service-sdk";
import { fixtureMessages, seedMessages } from "../src/seed.ts";
import { encryptToken } from "../src/token-vault.ts";

function pending(wallet: Wallet, amount: number, now: Date): Proposal {
  return {
    id: randomUUID(),
    owner: wallet.owner,
    service_id: wallet.service_id,
    wallet_id: wallet.id,
    kind: "buy",
    title: "Test action",
    rationale: "Explicit owner approval",
    amount,
    quantity: 1,
    item_id: "coffee-250g",
    quote_id: randomUUID(),
    quote_expires: new Date(now.getTime() + 300000).toISOString(),
    wallet_revision: wallet.revision,
    merchant_action_id: randomUUID(),
    status: "APPROVED",
    reason: null,
    reserved: 0,
    period_key: null,
    paypal_order_id: null,
    capture_id: null,
    booking: null,
    condition_under: null,
    condition_expires: null,
    period_end: null,
    cancel_effective_at: null,
    sources: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}
function setup() {
  const now = new Date("2026-11-11T12:00:00Z"),
    store = new AppStore(
      ":memory:",
      () => now,
      "wallet-test-encryption-secret-with-32-characters",
    ),
    wallet = store.ensureWallet(
      "owner-a",
      catalogue.services.find((s) => s.id === "basil-market")!,
    );
  wallet.mode = "ask";
  wallet.vault_id = "test-token";
  wallet.cap = 15000;
  wallet.per_action = 10000;
  store.saveWallet(wallet);
  return { store, wallet, now };
}

test("competing approvals cannot exceed one wallet budget and admission retries do not reserve twice", () => {
  const { store, wallet, now } = setup();
  try {
    const a = pending(wallet, 10000, now),
      b = pending(wallet, 10000, now);
    store.saveProposal(a);
    store.saveProposal(b);
    assert.equal(store.reserve("owner-a", a.id).reserved, 10000);
    assert.equal(store.reserve("owner-a", a.id).reserved, 10000);
    assert.throws(() => store.reserve("owner-a", b.id), /enough remaining/);
    assert.equal(store.publicWallet("owner-a", wallet).available, 5000);
    assert.equal(store.publicWallet("owner-a", wallet).reserved, 10000);
  } finally {
    store.close();
  }
});
test("wallet isolation and ownership prevent cross-service or cross-session balance access", () => {
  const { store, wallet, now } = setup();
  try {
    const p = pending(wallet, 9000, now);
    store.saveProposal(p);
    store.reserve("owner-a", p.id);
    const other = store.ensureWallet(
      "owner-a",
      catalogue.services.find((s) => s.id === "coast-screen")!,
    );
    assert.equal(store.publicWallet("owner-a", other).available, 2000);
    assert.throws(() => store.wallet("owner-b", wallet.id), /not available/);
    assert.throws(() => store.proposal("owner-b", p.id), /not available/);
  } finally {
    store.close();
  }
});
test("rules, paused state, expired quote and draft permission are rechecked before dispatch", () => {
  const { store, wallet, now } = setup();
  try {
    const p = pending(wallet, 500, now);
    store.saveProposal(p);
    wallet.revision++;
    store.saveWallet(wallet);
    assert.throws(() => store.reserve("owner-a", p.id), /changed/);
    p.wallet_revision = wallet.revision;
    store.saveProposal(p);
    wallet.paused = true;
    store.saveWallet(wallet);
    assert.throws(() => store.reserve("owner-a", p.id), /paused/);
    wallet.paused = false;
    wallet.mode = "draft";
    store.saveWallet(wallet);
    assert.throws(() => store.reserve("owner-a", p.id), /draft only/);
    wallet.mode = "ask";
    store.saveWallet(wallet);
    p.quote_expires = new Date(now.getTime() - 1).toISOString();
    store.saveProposal(p);
    assert.throws(() => store.reserve("owner-a", p.id), /expired/);
  } finally {
    store.close();
  }
});
test("cap reductions cannot erase committed spend and period keys respect Dubai boundaries", () => {
  const { store, wallet, now } = setup();
  try {
    const p = pending(wallet, 10000, now);
    store.saveProposal(p);
    store.reserve("owner-a", p.id);
    const app = new AppService(store);
    assert.throws(
      () =>
        app.updateRules("owner-a", wallet.id, {
          revision: wallet.revision,
          cap: 9000,
          per_action: 9000,
          auto_under: 0,
          daily_limit: 3,
          mode: "ask",
        }),
      /spent or reserved/,
    );
    assert.equal(
      periodKey(wallet, new Date("2026-11-15T19:59:59Z")),
      "week:2026-11-09",
    );
    assert.equal(
      periodKey(wallet, new Date("2026-11-15T20:00:00Z")),
      "week:2026-11-16",
    );
    assert.equal(
      periodKey(
        { ...wallet, period: "month" },
        new Date("2026-11-30T20:00:00Z"),
      ),
      "month:2026-12",
    );
  } finally {
    store.close();
  }
});
test("session tampering is rejected without exposing signing material", () => {
  const previous = process.env.APP_SESSION_SECRET;
  process.env.APP_SESSION_SECRET =
    "test-session-key-that-is-long-enough-for-signing";
  try {
    const value = createSession();
    assert(ownerFromSession(value));
    assert.equal(ownerFromSession(value.replace(/^./, "x")), null);
    assert.equal(ownerFromSession(undefined), null);
  } finally {
    if (previous === undefined) delete process.env.APP_SESSION_SECRET;
    else process.env.APP_SESSION_SECRET = previous;
  }
});

test("saved payment tokens are encrypted and tampering fails closed", () => {
  const { store, wallet } = setup();
  try {
    const row = store.db
      .prepare("SELECT body FROM wallets WHERE id=?")
      .get(wallet.id)!;
    assert(!String(row.body).includes("test-token"));
    assert.equal(store.wallet("owner-a", wallet.id).vault_id, "test-token");
    const body = JSON.parse(String(row.body));
    body.vault_id =
      body.vault_id.slice(0, -1) + (body.vault_id.endsWith("0") ? "1" : "0");
    store.db
      .prepare("UPDATE wallets SET body=? WHERE id=?")
      .run(JSON.stringify(body), wallet.id);
    assert.throws(
      () => store.wallet("owner-a", wallet.id),
      /could not be unlocked/,
    );
  } finally {
    store.close();
  }
});
test("expired wallet permission blocks new dispatch", () => {
  const { store, wallet, now } = setup();
  try {
    wallet.expires_at = new Date(now.getTime() - 1).toISOString();
    store.saveWallet(wallet);
    const p = pending(wallet, 500, now);
    store.saveProposal(p);
    assert.throws(() => store.reserve("owner-a", p.id), /permission expired/);
    assert.equal(store.proposal("owner-a", p.id).reserved, 0);
  } finally {
    store.close();
  }
});
test("reset schedule changes wait for the old boundary and retain earlier exposure", () => {
  let now = new Date("2026-11-11T12:00:00Z");
  const store = new AppStore(
    ":memory:",
    () => now,
    "test-reset-key-with-at-least-32-characters",
  );
  try {
    const wallet = store.ensureWallet(
      "owner",
      catalogue.services.find((s) => s.id === "basil-market")!,
    );
    wallet.mode = "ask";
    wallet.vault_id = "fixture";
    store.saveWallet(wallet);
    const p = pending(wallet, 1000, now);
    store.saveProposal(p);
    store.reserve("owner", p.id);
    const service = new AppService(store);
    service.updateRules("owner", wallet.id, {
      revision: wallet.revision,
      cap: 15000,
      per_action: 15000,
      auto_under: 0,
      daily_limit: 3,
      mode: "ask",
      period: "month",
      timezone: "UTC",
    });
    assert.equal(store.wallet("owner", wallet.id).period, "week");
    assert.equal(
      store.wallet("owner", wallet.id).pending_reset?.period,
      "month",
    );
    now = new Date("2026-11-16T00:01:00Z");
    const changed = store.wallet("owner", wallet.id);
    assert.equal(changed.period, "month");
    assert.equal(changed.timezone, "UTC");
    assert.equal(store.publicWallet("owner", changed).prior_reserved, 1000);
    assert.equal(store.proposal("owner", p.id).reserved, 1000);
  } finally {
    store.close();
  }
});
test("the 24 committed email previews are idempotent and received mail is not duplicated", async () => {
  const store = new AppStore(":memory:");
  try {
    await seedMessages(store, "owner", false);
    await seedMessages(store, "owner", false);
    assert.equal(store.messages("owner").length, 24);
    const preview = fixtureMessages("owner")[0]!;
    const received = {
      ...preview,
      provider_id: "actual-provider-id",
      origin: "agentmail" as const,
    };
    store.saveMessage(received);
    store.saveMessage({ ...received, id: "racing-copy" });
    assert.equal(store.messages("owner").length, 24);
    store.setSetting("message-mode:owner", "live");
    assert.equal(store.messages("owner").length, 24);
    assert.equal(
      store.messages("owner").filter((m) => m.origin === "fixture_preview")
        .length,
      23,
    );
    assert.equal(
      store.messages("owner").find((m) => m.origin === "agentmail")!
        .provider_id,
      "actual-provider-id",
    );
  } finally {
    store.close();
  }
});

test("revocation stops authority immediately and retries failed provider removal", async () => {
  const { store, wallet } = setup();
  const previous = [
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET,
  ];
  process.env.PAYPAL_CLIENT_ID = "fixture";
  process.env.PAYPAL_CLIENT_SECRET = "fixture";
  try {
    const paypal = new PayPal();
    let fail = true;
    paypal.removeToken = async () => {
      if (fail)
        throw new MerchantError("PROVIDER_UNAVAILABLE", "fixture outage");
      return {};
    };
    const app = new AppService(store, paypal);
    const revoked = await app.revoke("owner-a", wallet.id);
    assert.equal(revoked.connected, false);
    assert.equal(revoked.revocation_pending, true);
    assert.equal(store.wallet("owner-a", wallet.id).status, "revoked");
    assert.throws(() => app.pause("owner-a", wallet.id, false), /Reconnect/);
    assert.throws(() => app.reconnect("owner-a", wallet.id), /disconnection/);
    fail = false;
    await app.cleanupTokens("owner-a");
    assert.equal(store.wallet("owner-a", wallet.id).vault_id, null);
    assert.equal(app.reconnect("owner-a", wallet.id).mode, "draft");
    assert.equal(store.wallet("owner-a", wallet.id).cap, 15000);
  } finally {
    store.close();
    for (const [index, key] of [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
    ].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});
test("revoking one service cannot delete a token still used by another service", async () => {
  const { store, wallet } = setup();
  const previous = [
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET,
  ];
  process.env.PAYPAL_CLIENT_ID = "fixture";
  process.env.PAYPAL_CLIENT_SECRET = "fixture";
  try {
    const second = store.ensureWallet(
      "other-owner",
      catalogue.services.find((s) => s.id === "coast-screen")!,
    );
    second.vault_id = wallet.vault_id;
    second.mode = "ask";
    store.saveWallet(second);
    const paypal = new PayPal();
    let deleted = 0;
    paypal.removeToken = async () => {
      deleted++;
      return {};
    };
    const app = new AppService(store, paypal);
    await app.revoke("owner-a", wallet.id);
    assert.equal(deleted, 0);
    assert.equal(store.wallet("owner-a", wallet.id).vault_id, null);
    assert.equal(store.wallet("other-owner", second.id).vault_id, "test-token");
  } finally {
    store.close();
    for (const [index, key] of [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
    ].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});
test("in-flight revocation retains the token only until original payment reconciliation", async () => {
  const { store, wallet, now } = setup();
  const previous = [
    process.env.PAYPAL_CLIENT_ID,
    process.env.PAYPAL_CLIENT_SECRET,
  ];
  process.env.PAYPAL_CLIENT_ID = "fixture";
  process.env.PAYPAL_CLIENT_SECRET = "fixture";
  try {
    const p = pending(wallet, 500, now);
    store.saveProposal(p);
    store.reserve("owner-a", p.id);
    let deleted = 0;
    const paypal = new PayPal();
    paypal.removeToken = async () => {
      deleted++;
      return {};
    };
    const app = new AppService(store, paypal);
    // A concurrent setup can queue the same provider token without a wallet ID.
    store.setSetting("token-cleanup:owner-a:orphan-setup", {
      encrypted: encryptToken(wallet.vault_id!, store.vaultSecret),
    });
    await app.revoke("owner-a", wallet.id);
    assert.equal(deleted, 0);
    assert.equal(store.proposal("owner-a", p.id).status, "PAYING");
    const completed = store.proposal("owner-a", p.id);
    completed.status = "PAID";
    completed.reserved = 0;
    store.saveProposal(completed);
    await app.cleanupTokens("owner-a");
    assert.equal(deleted, 1);
    assert.equal(store.wallet("owner-a", wallet.id).vault_id, null);
    assert.equal(
      store.publicWallet("owner-a", store.wallet("owner-a", wallet.id)).spent,
      500,
    );
  } finally {
    store.close();
    for (const [index, key] of [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
    ].entries()) {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    }
  }
});

test("provider inbox limit during live seeding preserves all previews and received evidence", async () => {
  const store = new AppStore(":memory:");
  const previousKey = process.env.AGENTMAIL_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.AGENTMAIL_API_KEY = "fixture-key";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      {
        name: "LimitExceededError",
        code: "limit_exceeded",
        message: "Inbox limit exceeded",
      },
      { status: 403 },
    );
  };
  try {
    await seedMessages(store, "owner", false);
    const preview = fixtureMessages("owner")[0]!;
    store.saveMessage({
      ...preview,
      origin: "agentmail",
      provider_id: "received-before-failure",
    });
    await assert.rejects(
      seedMessages(store, "owner", true),
      (error: unknown) =>
        error instanceof MerchantError && error.code === "EMAIL_INBOX_LIMIT",
    );
    assert.equal(calls, 1);
    assert.equal(store.messages("owner").length, 24);
    assert.equal(
      store.messages("owner").filter((m) => m.origin === "fixture_preview")
        .length,
      23,
    );
    assert.equal(
      store.messages("owner").find((m) => m.origin === "agentmail")!
        .provider_id,
      "received-before-failure",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousKey;
    store.close();
  }
});
