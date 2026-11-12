import { seedMessages } from "../src/seed.ts";
import { incomingService } from "../src/email.ts";
import { extractEmail } from "../src/ai.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfirmation } from "../src/receipt-matching.ts";
import {
  prepareCancellationReview,
  confirmCancellationReview,
} from "../src/cancellation-review.ts";
import { merchantTool } from "../src/service-connector.ts";
import { digestFor } from "../src/queue.ts";
import {
  managedServices,
  managedServiceStatus,
} from "../src/managed-services.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AppStore } from "../src/app-store.ts";
import { AppService } from "../src/app-service.ts";
import { PayPal } from "../src/paypal.ts";
import { catalogue } from "../src/catalogue.ts";
import type { AgentTurn } from "../src/agent-model.ts";
import {
  Merchant,
  createService,
  createMerchantHttp,
  MerchantError,
  type VerifiedCapture,
  type Action,
  type Service,
} from "@mailbox/service-sdk";

async function fixture(
  options: {
    loseFirstResponse?: boolean;
    turn?: AgentTurn;
    appPath?: string;
    services?: Service[];
  } = {},
) {
  let instant = "2026-11-11T12:00:00Z";
  const now = () => new Date(instant);
  const merchant = new Merchant(
    ":memory:",
    structuredClone(options.services ?? catalogue.services),
    "maya",
    now,
  );
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
    options.appPath ?? ":memory:",
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
    options.turn,
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
    request,
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

test("a request composes discovery, current quote and proposal through the real MCP connector", async () => {
  const f = await fixture({
    turn: async (_context, history) => {
      const id = String(history.length);
      if (!history.length)
        return { id, name: "list_services", arguments: { query: "" } };
      if (history.length === 1) {
        const found = history[0]!.result as {
          services: typeof catalogue.services;
        };
        const service = found.services.find((s) => s.id === "coast-screen")!;
        assert(service);
        return {
          id,
          name: "get_quote",
          arguments: {
            service_id: service.id,
            item_id: service.items[0]!.id,
            quantity: 1,
            booking: null,
          },
        };
      }
      if (history.length === 2) {
        const quote = history[1]!.result as {
          id: string;
          amount_minor: number;
        };
        assert.equal(quote.amount_minor, 799);
        return {
          id,
          name: "prepare_proposal",
          arguments: {
            quote_id: quote.id,
            rationale: "One month using the current service quote.",
            sources: [],
            condition_under_minor: null,
          },
        };
      }
      assert(
        !("error" in (history[2]!.result as object)),
        JSON.stringify(history[2]!.result),
      );
      assert.equal(
        (history[2]!.result as { status: string }).status,
        "NEEDS_APPROVAL",
      );
      return {
        id,
        name: "finish",
        arguments: {
          answer: "The current quote is ready for your review.",
          sources: [],
        },
      };
    },
  });
  try {
    const actor = f.store.createAgent("owner", {
      name: "Research",
      purpose:
        "Compare supported service options and prepare a proposal for review",
    });
    const assigned = f.store.wallet("owner", f.wallet.id);
    assigned.agent_id = actor.id;
    f.store.saveWallet(assigned);
    const found = await f.app.ask(
      "owner",
      "Prepare a current quote for a month of streaming, for my review",
      actor.id,
    );
    assert.equal(found.type, "proposal");
    assert("proposal" in found);
    assert.equal(found.proposal.amount, 799);
    assert.equal(
      found.proposal.owner_request,
      "Prepare a current quote for a month of streaming, for my review",
    );
    assert.equal(found.proposal.status, "NEEDS_APPROVAL");
    assert.equal(found.proposal.capture_id, null);
    assert("steps" in found);
    assert.deepEqual(found.steps, [
      "list_services",
      "get_quote",
      "prepare_proposal",
    ]);
    assert.equal(f.charges(), 0);
  } finally {
    await f.close();
  }
});
test("fresh review expires only this agent's undispatched quotes and retains uncertain payment records", async () => {
  const f = await fixture({
    turn: async () => ({
      id: "done",
      name: "finish",
      arguments: { answer: "Review checked; no action executed.", sources: [] },
    }),
  });
  try {
    const actor = f.store.createAgent("owner", {
      name: "Reviewer",
      purpose: "Review current service terms",
    });
    actor.email = f.wallet.email;
    f.store.saveAgent(actor);
    const p = await f.app.propose("owner", "coast-screen", "subscribe", {
      agent_id: actor.id,
      owner_request: "One month, under USD 10, for review.",
    });
    const other = f.store.createAgent("owner", {
      name: "Other",
      purpose: "Separate purchases",
    });
    const unrelated = await f.app.propose("owner", "basil-market", "buy", {
      agent_id: other.id,
    });
    const pending = {
      ...p,
      id: "uncertain-payment",
      status: "RECONCILING" as const,
      reserved: 799,
      merchant_action_id: "existing-action",
      paypal_order_id: "existing-order",
    };
    f.store.saveProposal(pending);
    f.advanceTo("2026-11-11T12:10:00Z");
    await f.app.ask("owner", p.owner_request!, actor.id);
    assert.equal(f.store.proposal("owner", p.id).status, "EXPIRED");
    assert.equal(
      f.store.proposal("owner", unrelated.id).status,
      "NEEDS_APPROVAL",
    );
    assert.equal(f.store.proposal("owner", pending.id).status, "RECONCILING");
    assert.equal(f.store.proposal("owner", pending.id).reserved, 799);
    assert.equal(f.charges(), 0);
  } finally {
    await f.close();
  }
});

test("reviewed project closeout verifies per-service outcomes, retains costs and isolates another agent", async () => {
  const f = await fixture();
  try {
    const dev = f.store.createAgent("owner", {
      name: "Dev",
      purpose: "Manage services for a project",
    });
    dev.email = "dev@example.test";
    dev.inbox_id = "fixture-dev";
    f.store.saveAgent(dev);
    const paid = [];
    for (const serviceId of ["forge-build", "beacon-logs"]) {
      const service = catalogue.services.find((s) => s.id === serviceId)!;
      const wallet = f.store.ensureWallet("owner", service);
      wallet.agent_id = dev.id;
      wallet.email = dev.email;
      wallet.inbox_id = dev.inbox_id;
      wallet.vault_id = "fixture-vault-token";
      wallet.mode = "ask";
      f.store.saveWallet(wallet);
      const p = await f.app.propose("owner", serviceId, "subscribe", {
        agent_id: dev.id,
      });
      await f.app.approve("owner", p.id);
      paid.push(f.store.proposal("owner", p.id));
    }
    const reel = f.store.createAgent("owner", {
      name: "Reel",
      purpose: "Separate personal service",
    });
    reel.email = "reel@example.test";
    reel.inbox_id = "fixture-reel";
    f.store.saveAgent(reel);
    const separate = f.store.wallet("owner", f.wallet.id);
    separate.agent_id = reel.id;
    separate.email = reel.email;
    f.store.saveWallet(separate);
    const personal = await f.app.propose("owner", "coast-screen", "subscribe", {
      agent_id: reel.id,
    });
    await f.app.approve("owner", personal.id);
    assert.equal(f.charges(), 3);
    let failBeacon = true;
    const cancellations = new Map<string, number>();
    const rpc: typeof merchantTool<Action> = async (service, name, args) => {
      if (name === "cancel") {
        cancellations.set(service!, 1 + (cancellations.get(service!) ?? 0));
        if (service === "beacon-logs" && failBeacon) {
          failBeacon = false;
          throw Error("Simulated temporary merchant failure");
        }
      }
      return merchantTool<Action>(service, name, args);
    };
    await assert.rejects(
      prepareCancellationReview(
        f.store,
        "owner",
        dev.id,
        [personal.id],
        "immediate",
        rpc,
      ),
      /not available/,
    );
    const review = await prepareCancellationReview(
      f.store,
      "owner",
      dev.id,
      paid.map((p) => p.id),
      "immediate",
      rpc,
    );
    assert.equal(review.status, "DRAFT");
    assert.equal(cancellations.size, 0);
    for (const p of paid)
      assert.equal(
        f.merchant.status(p.service_id, p.merchant_action_id!).status,
        "ACTIVE",
      );
    await assert.rejects(
      confirmCancellationReview(
        f.store,
        "owner",
        review.id,
        review.revision + 1,
        rpc,
      ),
      /review changed/i,
    );
    assert.equal(cancellations.size, 0);
    const first = await confirmCancellationReview(
      f.store,
      "owner",
      review.id,
      review.revision,
      rpc,
    );
    assert.equal(first.status, "PARTIAL");
    assert.deepEqual(
      first.entries.map((e) => e.status),
      ["ENDED", "NEEDS_REVIEW"],
    );
    assert.equal(
      f.merchant.status(
        "coast-screen",
        f.store.proposal("owner", personal.id).merchant_action_id!,
      ).status,
      "ACTIVE",
    );
    const second = await confirmCancellationReview(
      f.store,
      "owner",
      review.id,
      first.revision,
      rpc,
    );
    assert.equal(second.status, "COMPLETE");
    assert(second.entries.every((e) => e.status === "ENDED"));
    assert.equal(cancellations.get("forge-build"), 1);
    assert.equal(cancellations.get("beacon-logs"), 2);
    await confirmCancellationReview(
      f.store,
      "owner",
      review.id,
      second.revision,
      rpc,
    );
    assert.equal(cancellations.get("forge-build"), 1);
    assert.equal(f.charges(), 3);
    assert.equal(
      paid.reduce(
        (sum, p) =>
          sum +
          f.store.publicWallet("owner", f.store.wallet("owner", p.wallet_id))
            .spent,
        0,
      ),
      1600,
    );
    assert(paid.every((p) => !f.store.wallet("owner", p.wallet_id).paused));
    assert.equal(
      f.merchant.outbox().filter((m) => m.type === "cancellation").length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("an agent total allowance constrains separate service wallets and cannot erase committed costs", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent("owner", {
      name: "Project",
      purpose: "One bounded project",
    });
    agent.email = "project@example.test";
    agent.inbox_id = "fixture-project";
    f.store.saveAgent(agent);
    let allowance = f.store.saveAgentAllowance("owner", agent.id, {
      limit: 2500,
      expires_at: "2026-12-11T12:00:00Z",
      paused: false,
      expected_revision: null,
    });
    const proposals = [];
    for (const id of ["forge-build", "beacon-logs", "harbor-play"]) {
      const w = f.store.ensureWallet(
        "owner",
        catalogue.services.find((s) => s.id === id)!,
      );
      w.agent_id = agent.id;
      w.email = agent.email;
      w.inbox_id = agent.inbox_id;
      w.vault_id = "fixture-vault-token";
      w.mode = "ask";
      f.store.saveWallet(w);
      proposals.push(
        await f.app.propose("owner", id, "subscribe", { agent_id: agent.id }),
      );
    }
    await f.app.approve("owner", proposals[0]!.id);
    await f.app.approve("owner", proposals[1]!.id);
    allowance = f.store.agentAllowance("owner", agent.id)!;
    assert.equal(allowance.spent, 1600);
    assert.equal(allowance.available, 900);
    await assert.rejects(
      f.app.approve("owner", proposals[2]!.id),
      /total allowance/,
    );
    assert.equal(f.charges(), 2);
    assert.equal(
      f.store.proposal("owner", proposals[2]!.id).status,
      "NEEDS_APPROVAL",
    );
    assert.throws(
      () =>
        f.store.saveAgentAllowance("owner", agent.id, {
          limit: 1500,
          expires_at: allowance.expires_at,
          paused: false,
          expected_revision: allowance.revision,
        }),
      /cannot erase/,
    );
    allowance = f.store.saveAgentAllowance("owner", agent.id, {
      limit: 2500,
      expires_at: allowance.expires_at,
      paused: true,
      expected_revision: allowance.revision,
    });
    await assert.rejects(f.app.approve("owner", proposals[2]!.id), /paused/);
    allowance = f.store.saveAgentAllowance("owner", agent.id, {
      limit: 2500,
      expires_at: "2026-11-10T12:00:00Z",
      paused: false,
      expected_revision: allowance.revision,
    });
    await assert.rejects(
      f.app.approve("owner", proposals[2]!.id),
      /allowance expired/,
    );
    assert.equal(f.charges(), 2);
    assert.equal(f.store.agentAllowance("owner", agent.id)!.spent, 1600);
  } finally {
    await f.close();
  }
});

test("concurrent approvals cannot overspend one agent allowance across two services", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent("owner", {
      name: "Bounded",
      purpose: "Shared allowance",
    });
    agent.email = "bounded@example.test";
    agent.inbox_id = "fixture-bounded";
    f.store.saveAgent(agent);
    f.store.saveAgentAllowance("owner", agent.id, {
      limit: 1200,
      expires_at: "2026-12-11T12:00:00Z",
      paused: false,
      expected_revision: null,
    });
    const proposals = [];
    for (const id of ["forge-build", "beacon-logs"]) {
      const w = f.store.ensureWallet(
        "owner",
        catalogue.services.find((s) => s.id === id)!,
      );
      w.agent_id = agent.id;
      w.email = agent.email;
      w.inbox_id = agent.inbox_id;
      w.vault_id = "fixture-vault-token";
      w.mode = "ask";
      f.store.saveWallet(w);
      proposals.push(
        await f.app.propose("owner", id, "subscribe", { agent_id: agent.id }),
      );
    }
    const outcomes = await Promise.allSettled(
      proposals.map((p) => f.app.approve("owner", p.id)),
    );
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.charges(), 1);
    const allowance = f.store.agentAllowance("owner", agent.id)!;
    assert(allowance.spent <= 1200);
    assert.equal(allowance.reserved, 0);
    const unpaid = f.store.proposals("owner").find((p) => p.status !== "PAID");
    assert.equal(
      unpaid?.status,
      "NEEDS_APPROVAL",
      "the rejected approval must remain reviewable by the owner",
    );
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

test("managed-service inspection verifies access, identity, confirmation and budget without another payment", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent("owner", {
      name: "Media",
      purpose: "Keep my services and receipts together",
    });
    agent.email = "media@example.test";
    agent.inbox_id = "fixture-inbox";
    agent.status = "connected";
    f.store.saveAgent(agent);
    const wallet = f.store.wallet("owner", f.wallet.id);
    wallet.agent_id = agent.id;
    wallet.email = agent.email;
    wallet.inbox_id = agent.inbox_id;
    f.store.saveWallet(wallet);
    const proposal = await f.app.propose("owner", "coast-screen", "subscribe", {
      agent_id: agent.id,
    });
    const pending = await managedServiceStatus(
      f.store,
      "owner",
      agent.id,
      proposal.id,
    );
    assert.equal(pending.payment_confirmed, false);
    assert.equal(pending.merchant_status, null);
    await f.app.approve("owner", proposal.id);
    const paid = f.store.proposal("owner", proposal.id);
    assert.equal(f.charges(), 1);
    const receipt = f.merchant.outbox()[0]!;
    assert.equal(receipt.attachments?.length, 1);
    const invoice = Buffer.from(
      receipt.attachments![0]!.content_base64,
      "base64",
    ).toString("utf8");
    assert(invoice.includes(agent.email!));
    assert(invoice.includes(paid.merchant_action_id!));
    assert(invoice.includes("USD 7.99"));
    assert(invoice.includes(paid.capture_id!));
    f.store.saveMessage({
      id: "received-confirmation",
      owner: "owner",
      agent_id: agent.id,
      service_id: paid.service_id,
      provider_id: "fixture-confirmation",
      subject: receipt.subject,
      from: "Merchant <receipt@example.test>",
      recipients: [agent.email!],
      text: receipt.text,
      received_at: "2026-11-11T12:00:00Z",
      kind: "confirmation",
      facts: {
        item: paid.title,
        amount_minor: paid.amount,
        currency: "USD",
        expires: paid.period_end,
        action_id: paid.merchant_action_id,
        suspicious: false,
      },
      origin: "agentmail",
    });
    const services = managedServices(f.store, "owner", agent.id);
    assert.equal(services.length, 1);
    assert.equal(services[0]!.actions[0]!.has_verified_capture, true);
    const status = await managedServiceStatus(
      f.store,
      "owner",
      agent.id,
      proposal.id,
    );
    assert.equal(status.payment_confirmed, true);
    assert.equal(status.identity_verified, true);
    assert.equal(status.access_active, true);
    assert.equal(status.wallet.spent, 799);
    assert.equal(status.wallet.reserved, 0);
    assert.deepEqual(status.received_confirmation_sources, [
      "received-confirmation",
    ]);
    const matched = await checkConfirmation(
      f.store,
      "owner",
      agent.id,
      "received-confirmation",
    );
    assert.equal(matched.status, "matched");
    assert("payment" in matched && matched.payment.payment_confirmed);
    assert.equal(f.charges(), 1);
    const other = f.store.createAgent("owner", {
      name: "Other",
      purpose: "Unrelated",
    });
    let called = false;
    await assert.rejects(
      managedServiceStatus(
        f.store,
        "owner",
        other.id,
        proposal.id,
        async () => {
          called = true;
          throw Error("Must not call");
        },
      ),
      /not available/,
    );
    assert.equal(called, false);
    assert.deepEqual(managedServices(f.store, "owner", other.id), []);
    const raw = f.merchant.status(paid.service_id, paid.merchant_action_id!);
    const wrongAlias = await managedServiceStatus(
      f.store,
      "owner",
      agent.id,
      proposal.id,
      async () => ({ ...raw, address: "unrelated@example.test" }),
    );
    assert.equal(wrongAlias.identity_verified, false);
    assert.equal(wrongAlias.access_active, false);
    f.advanceTo("2026-12-12T12:00:00Z");
    const ended = await managedServiceStatus(
      f.store,
      "owner",
      agent.id,
      proposal.id,
    );
    assert.equal(ended.payment_confirmed, true);
    assert.equal(ended.access_active, false);
    assert.equal(ended.merchant_status, "CANCELED");
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});
test("a subscription can belong to any user-chosen agent and keeps that agent's alias through payment", async () => {
  const f = await fixture();
  try {
    const agent = f.store.createAgent("owner", {
      name: "Tech Shopping",
      purpose: "Manage my software and the subscriptions I choose.",
      tags: ["work"],
    });
    agent.email = "coast@example.test";
    agent.inbox_id = "fixture-inbox";
    agent.status = "connected";
    f.store.saveAgent(agent);
    const proposal = await f.app.propose("owner", "coast-screen", "subscribe", {
      agent_id: agent.id,
    });
    assert.equal(proposal.agent_id, agent.id);
    assert.equal(
      f.store.wallet("owner", proposal.wallet_id).agent_id,
      agent.id,
    );
    assert.notEqual(proposal.wallet_id, f.wallet.id);
    const fresh = f.store.wallet("owner", proposal.wallet_id);
    assert.equal(fresh.vault_id, null);
    assert.equal(fresh.mode, "draft");
    await assert.rejects(
      f.app.approve("owner", proposal.id),
      /Choose Ask every time/,
    );
    // This identity grants its own test permission; the existing wallet is untouched.
    fresh.email = agent.email;
    fresh.inbox_id = agent.inbox_id;
    fresh.mode = "ask";
    fresh.vault_id = "separately-approved-fixture-token";
    f.store.saveWallet(fresh);
    await f.app.approve("owner", proposal.id);
    const paid = f.store.proposal("owner", proposal.id);
    assert.equal(paid.status, "PAID");
    assert.equal(
      f.merchant.status("coast-screen", paid.merchant_action_id!).address,
      agent.email,
    );
    assert.equal(f.merchant.outbox()[0]!.to, agent.email);
    const other = f.store.createAgent("someone-else", {
      name: "Other",
      purpose: "Other owner",
    });
    await assert.rejects(
      f.app.propose("owner", "harbor-play", "subscribe", {
        agent_id: other.id,
      }),
      /not available/,
    );
    assert.equal(f.charges(), 1);
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
test("linked verified history can be read but cannot acquire local execution authority", async () => {
  const f = await fixture();
  try {
    const service = catalogue.services.find((s) => s.id === "coast-screen")!;
    const w = f.store.ensureWallet("owner", service);
    w.mode = "ask";
    w.vault_id = "fixture-vault-token";
    w.email = "owner@example.test";
    f.store.saveWallet(w);
    const p = await f.app.propose("owner", service.id, "subscribe");
    await f.app.approve("owner", p.id);
    const paid = f.store.proposal("owner", p.id);
    paid.history_source = {
      base_url: process.env.MOCK_MERCHANT_URL!,
      owner_id: "original-owner",
      wallet_id: "original-wallet",
      imported_at: f.store.now().toISOString(),
    };
    f.store.saveProposal(paid);
    const currentHost = process.env.MOCK_MERCHANT_URL;
    process.env.MOCK_MERCHANT_URL = "http://127.0.0.1:1";
    await f.app.sync("owner");
    process.env.MOCK_MERCHANT_URL = currentHost;
    assert.equal(f.charges(), 1);
    await assert.rejects(f.app.cancel("owner", paid.id), /read-only/);
    paid.status = "APPROVED";
    f.store.saveProposal(paid);
    await assert.rejects(f.app.pay("owner", paid.id), /read-only/);
    assert.equal(f.charges(), 1);
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
test("an invoice is prepared only at the service's own quote and a blocked message can be dismissed", async () => {
  const f = await fixture();
  try {
    await seedMessages(f.store, "owner", false);
    const state = f.app.state("owner");
    const invoice = state.messages.find((m) => m.kind === "invoice")!;
    const flagged = state.messages.find((m) => m.facts.suspicious)!;
    const proposal = await f.app.payInvoice("owner", invoice.id);
    assert.equal(proposal.status, "NEEDS_APPROVAL");
    assert.equal(proposal.amount, invoice.facts.amount_minor);
    assert.equal(proposal.title, "Pay Friday table deposit");
    assert.deepEqual(proposal.sources, [invoice.id]);
    assert.equal(proposal.agent_id, invoice.agent_id);
    assert.ok(proposal.booking);
    assert.equal(
      (await f.app.payInvoice("owner", invoice.id)).id,
      proposal.id,
      "asking twice reuses the open proposal",
    );
    await assert.rejects(
      f.app.payInvoice("owner", flagged.id),
      /not an invoice/,
    );
    f.app.dismissMessage("owner", flagged.id);
    f.app.dismissMessage("owner", flagged.id);
    assert.deepEqual(f.app.state("owner").dismissed, [flagged.id]);
    assert.equal(f.charges(), 0);
  } finally {
    await f.close();
  }
});
test("a digest sorts one agent's messages and a reply goes out once, only to a delivered message, only after approval", async () => {
  const f = await fixture();
  try {
    const sent: string[] = [];
    (
      f.app.mail as {
        sendReply?: (...args: [unknown, unknown, string, string]) => unknown;
      }
    ).sendReply = async (_agent, _message, text) => {
      sent.push(text);
      return "provider-message";
    };
    await seedMessages(f.store, "owner", false);
    const state = f.app.state("owner");
    const table = state.agents.find((agent) => agent.template === "dining")!;
    const digest = digestFor(state, table);
    assert.equal(digest.count, 6);
    assert.deepEqual(
      digest.needs.map((need) => need.kind),
      ["invoice"],
    );
    assert.equal(digest.notable.length + digest.aside.length, 5);
    assert.ok(digest.aside.length >= 1, "the expired offer is set aside");
    assert.ok(
      [...digest.notable, ...digest.aside].every(
        (line) => line.message.kind !== "invoice",
      ),
      "the invoice is listed once, under what needs the owner",
    );
    const paws = state.agents.find((agent) => agent.template === "pets")!;
    const blocked = state.messages.find((m) => m.facts.suspicious)!;
    assert.ok(
      [
        ...digestFor(state, paws).notable,
        ...digestFor(state, paws).aside,
      ].every((line) => line.message.id !== blocked.id),
      "a blocked message is never quoted in a digest",
    );
    const id = state.messages.find(
      (message) => message.agent_id === table.id && !message.facts.suspicious,
    )!.id;
    assert.equal(sent.length, 0);
    await assert.rejects(
      f.app.sendReply("owner", id, "Please move Friday to 8 pm.", "r1"),
      /address before it can reply/,
    );
    const agent = f.store.agent("owner", table.id);
    agent.inbox_id = "table@example.test";
    agent.email = "table@example.test";
    f.store.saveAgent(agent);
    await assert.rejects(
      f.app.sendReply("owner", id, "Please move Friday to 8 pm.", "r1"),
      /sample preview/,
    );
    const message = f.store.messages("owner").find((m) => m.id === id)!;
    f.store.saveMessage({
      ...message,
      origin: "agentmail",
      provider_id: "table@example.test:provider-1",
      reply_to: [],
      from: "Marina Table <hello@marina.example>",
    });
    await assert.rejects(
      f.app.sendReply("owner", id, "   ", "r1"),
      /up to 4,000 characters/,
    );
    await f.app.sendReply("owner", id, "Please move Friday to 8 pm.", "r1");
    await f.app.sendReply("owner", id, "Please move Friday to 8 pm.", "r1");
    assert.deepEqual(sent, ["Please move Friday to 8 pm."]);
    assert.ok(
      f.app.state("owner").audit.some((event) => event.action === "REPLY_SENT"),
    );
    await assert.rejects(
      f.app.sendReply("owner", blocked.id, "Hello", "r2"),
      /was blocked/,
    );
    assert.equal(f.charges(), 0);
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
async function monthlyRule(
  f: Awaited<ReturnType<typeof fixture>>,
  serviceId = "daily-paws",
  quantity = 1,
  maxAmount = 3000,
) {
  const agent = f.store.createAgent("owner", {
    name: "Restock",
    purpose: "Monthly exact-item household purchases",
  });
  agent.email = "restock@example.test";
  agent.inbox_id = agent.email;
  agent.status = "connected";
  f.store.saveAgent(agent);
  const wallet = f.store.ensureWallet(
    "owner",
    (await f.app.services()).find((s) => s.id === serviceId)!,
  );
  Object.assign(wallet, {
    agent_id: agent.id,
    email: agent.email,
    inbox_id: agent.inbox_id,
    mode: "auto",
    auto_under: 3000,
    per_action: 5000,
    cap: 10000,
    period: "month",
    timezone: "Asia/Dubai",
    expires_at: "2027-04-01T00:00:00Z",
    vault_id: "fixture-restock-token",
  });
  f.store.saveWallet(wallet);
  const p = await f.app.propose("owner", serviceId, "schedule", {
    agent_id: agent.id,
    quantity,
    monthly_schedule: {
      timezone: "Asia/Dubai",
      day_of_month: 12,
      local_time: "09:00",
      starts_at: "2026-11-12T05:00:00Z",
      expires_at: "2027-02-13T05:00:00Z",
      max_amount_minor: maxAmount,
      price_inclusive: false,
    },
  });
  return { agent, wallet, p };
}

test("monthly owner approval schedules an exact item and two concurrent ticks create one order in each new month", async () => {
  const f = await fixture();
  try {
    const { p, wallet } = await monthlyRule(f);
    f.store.saveAgentAllowance("owner", p.agent_id!, {
      limit: 6500,
      expires_at: "2027-04-01T00:00:00Z",
      paused: false,
      expected_revision: null,
    });
    const result = await f.app.approve("owner", p.id, {
      revision: wallet.revision,
      cap: wallet.cap,
      per_action: wallet.per_action,
      auto_under: wallet.auto_under,
      daily_limit: wallet.daily_limit,
      mode: "auto",
      period: "month",
      timezone: wallet.timezone,
      expires_at: wallet.expires_at,
    });
    assert.equal(result.type, "proposal");
    assert.equal(f.charges(), 0);
    assert.equal(f.store.proposal("owner", p.id).status, "WAITING");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 0);
    f.advanceTo("2026-11-12T05:00:00Z");
    await Promise.all([
      f.app.evaluateSchedules("owner"),
      f.app.evaluateSchedules("owner"),
    ]);
    assert.equal(f.charges(), 1);
    let children = f.store
      .proposals("owner")
      .filter((c) => c.scheduled_by?.proposal_id === p.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.status, "PAID");
    assert.equal(children[0]!.scheduled_by!.period, "2026-11");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 1);
    f.advanceTo("2026-12-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 2);
    assert.equal(f.merchant.outbox().length, 2);
    assert.equal(f.store.agentAllowance("owner", p.agent_id!)!.spent, 5998);
    assert.equal(f.store.agentAllowance("owner", p.agent_id!)!.reserved, 0);
    children = f.store
      .proposals("owner")
      .filter((c) => c.scheduled_by?.proposal_id === p.id);
    assert.deepEqual(children.map((c) => c.scheduled_by!.period).sort(), [
      "2026-11",
      "2026-12",
    ]);
    assert(
      children.every(
        (c) =>
          c.item_id === p.item_id &&
          c.quantity === 1 &&
          c.agent_id === p.agent_id,
      ),
    );
    assert.equal(f.store.wallet("owner", f.wallet.id).status, "draft");
    f.advanceTo("2027-01-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 2);
    assert.equal(f.store.proposal("owner", p.id).status, "NEEDS_APPROVAL");
  } finally {
    await f.close();
  }
});

test("lost monthly capture response survives a reopened store and reconciles the same purchase exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-monthly-")),
    path = join(dir, "app.sqlite");
  const f = await fixture({ loseFirstResponse: true, appPath: path });
  let reopened: AppStore | undefined;
  try {
    const { p } = await monthlyRule(f);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    const child = f.store
      .proposals("owner")
      .find((c) => c.scheduled_by?.proposal_id === p.id)!;
    assert.equal(child.status, "RECONCILING");
    assert.equal(child.reserved, 2999);
    assert.equal(f.charges(), 1);
    reopened = new AppStore(path, f.store.now, f.store.vaultSecret);
    const app = new AppService(reopened, new PayPal(f.request), f.app.mail);
    await app.evaluateSchedules("owner");
    await app.evaluateSchedules("owner");
    assert.equal(reopened.proposal("owner", child.id).status, "PAID");
    assert.equal(reopened.proposal("owner", child.id).reserved, 0);
    assert.equal(f.charges(), 1);
  } finally {
    reopened?.close();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("monthly exceptions stop automatic orders for higher prices, changed variants, stock, expiry and identity", async () => {
  const changes = [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.merchant.serviceById("daily-paws").items[0]!.amount_minor = 3000;
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.merchant.serviceById("daily-paws").items[0]!.name = "Different flavour";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.merchant.serviceById("daily-paws").items[0]!.in_stock = false;
    },
    (f: Awaited<ReturnType<typeof fixture>>, w: string) => {
      const wallet = f.store.wallet("owner", w);
      wallet.expires_at = "2026-11-12T04:00:00Z";
      f.store.saveWallet(wallet);
    },
    (f: Awaited<ReturnType<typeof fixture>>, w: string) => {
      const wallet = f.store.wallet("owner", w);
      wallet.auto_under = 2000;
      f.store.saveWallet(wallet);
    },
    (f: Awaited<ReturnType<typeof fixture>>, w: string) => {
      const wallet = f.store.wallet("owner", w);
      const a = f.store.agent("owner", wallet.agent_id!);
      a.email = "changed@example.test";
      f.store.saveAgent(a);
    },
  ];
  for (const change of changes) {
    const f = await fixture();
    try {
      const { p, wallet } = await monthlyRule(f);
      await f.app.approve("owner", p.id);
      change(f, wallet.id);
      f.advanceTo("2026-11-12T05:00:00Z");
      await f.app.evaluateSchedules("owner");
      await f.app.evaluateSchedules("owner");
      assert.equal(f.charges(), 0);
      assert.equal(f.store.proposal("owner", p.id).status, "NEEDS_APPROVAL");
      assert.equal(f.merchant.outbox().length, 0);
    } finally {
      await f.close();
    }
  }
});

test("replacing a monthly rule cannot order the same product twice in its current period", async () => {
  const f = await fixture();
  try {
    const { p } = await monthlyRule(f);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 1);
    f.app.decline("owner", p.id);
    const {
      item: _item,
      approved_at: _approved,
      ...input
    } = p.monthly_schedule!;
    const replacement = await f.app.propose("owner", p.service_id, "schedule", {
      agent_id: p.agent_id!,
      item_id: p.item_id,
      quantity: p.quantity,
      monthly_schedule: input,
    });
    await f.app.approve("owner", replacement.id);
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 1);
    const state = f.app.state("owner");
    assert.equal(
      state.proposals.find((c) => c.id === replacement.id)!.next_scheduled_at,
      "2026-12-12T05:00:00.000Z",
    );
    f.advanceTo("2026-12-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 2);
  } finally {
    await f.close();
  }
});

test("stopping a monthly rule between its quote and reservation prevents dispatch", async () => {
  const f = await fixture();
  try {
    const { p } = await monthlyRule(f);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    const pay = f.app.pay.bind(f.app);
    f.app.pay = async (owner, id) => {
      f.app.decline(owner, p.id);
      return pay(owner, id);
    };
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 0);
    assert.equal(f.store.proposal("owner", p.id).status, "DECLINED");
    assert(
      f.store
        .proposals("owner")
        .filter((c) => c.scheduled_by?.proposal_id === p.id)
        .every((c) => c.status === "BLOCKED"),
    );
  } finally {
    await f.close();
  }
});

test("a merchant rejection after a fresh quote pauses the monthly rule for review", async () => {
  const f = await fixture();
  try {
    const { p, wallet } = await monthlyRule(f);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    let attempts = 0;
    f.merchant.prepare = () => {
      attempts++;
      throw new MerchantError(
        "OUT_OF_STOCK",
        "Stock changed before the order could be placed.",
      );
    };
    await f.app.evaluateSchedules("owner");
    await f.app.evaluateSchedules("owner");
    assert.equal(attempts, 1);
    assert.equal(f.charges(), 0);
    assert.equal(f.store.proposal("owner", p.id).status, "NEEDS_APPROVAL");
    assert.equal(
      f.store.publicWallet("owner", f.store.wallet("owner", wallet.id))
        .reserved,
      0,
    );
  } finally {
    await f.close();
  }
});

test("stopping a monthly rule retains and reconciles an already dispatched payment without another order", async () => {
  const f = await fixture({ loseFirstResponse: true });
  try {
    const { p } = await monthlyRule(f);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 1);
    const child = f.store
      .proposals("owner")
      .find((c) => c.scheduled_by?.proposal_id === p.id)!;
    assert.equal(child.status, "RECONCILING");
    f.app.decline("owner", p.id);
    await f.app.sync("owner");
    assert.equal(f.store.proposal("owner", child.id).status, "PAID");
    assert.equal(f.charges(), 1);
    f.advanceTo("2026-12-12T05:00:00Z");
    await f.app.sync("owner");
    assert.equal(f.charges(), 1);
    assert.equal(f.store.proposal("owner", p.id).status, "DECLINED");
  } finally {
    await f.close();
  }
});

test("a newly configured merchant uses discovery, monthly purchase and scoped confirmation without client scenario code", async () => {
  const service = createService({
    id: "atelier-supply",
    name: "Atelier Supply",
    category: "household",
    paypalMerchant: catalogue.services[0]!.paypalMerchant,
    catalogue: [
      {
        id: "soap-200",
        name: "Cedar soap, 200 ml",
        amount_minor: 850,
        period: "once",
        terms: "Delivered total including tax",
        in_stock: true,
        unit: "ml",
        unit_quantity: 200,
        comparison_group: "cedar-soap",
      },
    ],
  });
  const f = await fixture({ services: [...catalogue.services, service] });
  try {
    const { p, agent } = await monthlyRule(f, service.id);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    const child = f.store
      .proposals("owner")
      .find((c) => c.scheduled_by?.proposal_id === p.id)!;
    assert.equal(child.status, "PAID");
    assert.equal(child.amount, 850);
    const receipt = f.merchant.outbox()[0]!,
      facts = await extractEmail(receipt.subject, receipt.text);
    const assigned = [{ id: service.id, name: service.name }];
    assert.notEqual(
      incomingService(receipt.text, service.name).service_id,
      service.id,
    );
    const identified = incomingService(
      receipt.text,
      service.name,
      undefined,
      assigned,
    );
    assert.equal(identified.service_id, service.id);
    f.store.saveMessage({
      id: "new-merchant-receipt",
      owner: "owner",
      agent_id: agent.id,
      service_id: identified.service_id,
      provider_id: `${agent.inbox_id}:receipt-1`,
      subject: receipt.subject,
      from: service.name,
      recipients: [agent.email!],
      text: receipt.text,
      received_at: f.store.now().toISOString(),
      kind: facts.kind,
      facts,
      origin: "agentmail",
    });
    const matched = await checkConfirmation(
      f.store,
      "owner",
      agent.id,
      "new-merchant-receipt",
    );
    assert.equal(matched.status, "matched");
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});

test("a future monthly price boundary can be lower than today's quote without granting payment above it", async () => {
  const f = await fixture();
  try {
    const { p, wallet } = await monthlyRule(f, "daily-paws", 1, 2500);
    const w = f.store.wallet("owner", wallet.id);
    w.auto_under = 2500;
    w.per_action = 2500;
    f.store.saveWallet(w);
    await f.app.approve("owner", p.id);
    assert.equal(f.charges(), 0);
    f.merchant.serviceById("daily-paws").items[0]!.amount_minor = 2450;
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    const child = f.store
      .proposals("owner")
      .find((c) => c.scheduled_by?.proposal_id === p.id)!;
    assert.equal(child.status, "PAID");
    assert.equal(child.amount, 2450);
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});

test("a changed current price within the monthly boundary uses the fresh delivered total", async () => {
  const f = await fixture();
  try {
    const { p } = await monthlyRule(f);
    await f.app.approve("owner", p.id);
    const item = f.merchant.serviceById("daily-paws").items[0]!;
    item.amount_minor = 2899;
    item.terms = "USD 28.99 for this exact item, tax and delivery included.";
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    const child = f.store
      .proposals("owner")
      .find((c) => c.scheduled_by?.proposal_id === p.id)!;
    assert.equal(child.amount, 2899);
    assert.equal(child.status, "PAID");
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});

test("the same monthly capability orders an unrelated product and exact quantity without new scenario code", async () => {
  const f = await fixture();
  try {
    const { p } = await monthlyRule(f, "basil-market", 2);
    await f.app.approve("owner", p.id);
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    const child = f.store
      .proposals("owner")
      .find((c) => c.scheduled_by?.proposal_id === p.id)!;
    assert.equal(child.status, "PAID");
    assert.equal(child.quantity, 2);
    assert.equal(child.amount, 1300);
    assert.equal(f.charges(), 1);
  } finally {
    await f.close();
  }
});

test("connecting saved payment consent arms the approved monthly rule without charging immediately", async () => {
  const f = await fixture();
  try {
    const { p, wallet } = await monthlyRule(f);
    const w = f.store.wallet("owner", wallet.id);
    w.vault_id = null;
    f.store.saveWallet(w);
    f.app.paypal.setup = async () => ({
      id: "setup-monthly",
      links: [
        { rel: "approve", href: "https://www.sandbox.paypal.com/approval" },
      ],
    });
    f.app.paypal.exchange = async () => "owner-consented-test-token";
    const redirect = await f.app.approve("owner", p.id);
    assert.equal(redirect.type, "redirect");
    assert("url" in redirect);
    const setupRows = f.store.db.prepare("SELECT id FROM setup").all();
    assert.equal(setupRows.length, 1);
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 0);
    await f.app.finishSetup("owner", setupRows[0]!.id as string);
    assert.equal(f.charges(), 0);
    assert.equal(f.store.proposal("owner", p.id).status, "WAITING");
    f.advanceTo("2026-11-12T05:00:00Z");
    await f.app.evaluateSchedules("owner");
    assert.equal(f.charges(), 1);
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
