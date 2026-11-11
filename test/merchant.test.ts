import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMerchantHttp,
  Merchant,
  createService,
  addBillingMonth,
  MerchantError,
  paypalSandboxVerifier,
  paypalSandboxWebhookVerifier,
  type Action,
  type Quote,
  type VerifiedCapture,
} from "@mailbox/service-sdk";
import { catalogue } from "../src/catalogue.ts";

const token = "mcp-test-token-with-more-than-32-characters";
const admin = "admin-test-token-with-more-than-32-characters";
let time = new Date("2026-11-11T10:00:00Z");
const merchant = new Merchant(
  ":memory:",
  catalogue.services,
  "maya",
  () => new Date(time),
);
const verified = new Map<string, VerifiedCapture>();
const http = createMerchantHttp({
  merchant,
  token,
  adminToken: admin,
  verifyCapture: async (id) => {
    const capture = verified.get(id);
    if (!capture)
      throw new MerchantError("CAPTURE_UNVERIFIED", "Unknown test capture.");
    return capture;
  },
  verifyWebhook: async (headers) =>
    headers["paypal-transmission-sig"] === "test-valid-signature",
});
let base: string;
const clients: Client[] = [];
before(async () => {
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
  merchant.close();
});
async function client(service = "") {
  const c = new Client({ name: "mailbox-e2e", version: "0.1.0" });
  await c.connect(
    new StreamableHTTPClientTransport(
      new URL(`${base}/mcp${service ? `/${service}` : ""}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ),
  );
  clients.push(c);
  return c;
}
async function invoke<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const content = result.structuredContent as
      { code?: string; message?: string } | undefined;
    throw new MerchantError(
      content?.code ?? "TOOL_ERROR",
      content?.message ?? JSON.stringify(result.content),
    );
  }
  return (result.structuredContent as { data: T }).data;
}
function capture(
  action: Action,
  id: string,
  amount = action.quote.amount_minor,
) {
  verified.set(id, {
    id,
    invoice_id: action.id,
    amount_minor: amount,
    currency: "USD",
    merchant_id: catalogue.services[0]!.paypalMerchant,
  });
}
async function confirm(actionId: string, captureId: string, key = admin) {
  return fetch(`${base}/internal/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action_id: actionId, capture_id: captureId }),
  });
}

test("real MCP discovery, streaming setup, independent payment confirmation and cancellation", async () => {
  const catalogue = await client();
  const options = await invoke<Array<{ id: string }>>(
    catalogue,
    "search_catalogue",
    { query: "The Lantern Coast" },
  );
  assert.equal(options.length, 3);
  const stream = await client("coast-screen");
  const tools = (await stream.listTools()).tools.map((tool) => tool.name);
  assert(tools.includes("subscribe"));
  assert(tools.includes("cancel"));
  assert(!tools.includes("confirm_payment"));
  const q = await invoke<Quote>(stream, "get_quote", { item_id: "monthly" });
  assert.equal(q.amount_minor, 799);
  const args = {
    quote_id: q.id,
    address: "coast-screen@example.test",
    idempotency_key: "stream-1",
    paid_periods: 1,
  };
  const action = await invoke<Action>(stream, "subscribe", args);
  assert.equal(action.status, "AWAITING_PAYMENT");
  assert.equal(action.renewal_disabled, true);
  assert.equal(merchant.outbox().length, 0);
  assert.equal((await invoke<Action>(stream, "subscribe", args)).id, action.id);
  assert.equal(
    (
      await invoke<Action>(stream, "subscribe", {
        ...args,
        idempotency_key: "stream-duplicate-quote",
      })
    ).id,
    action.id,
  );
  capture(action, "WRONG-AMOUNT", 1);
  assert.equal((await confirm(action.id, "WRONG-AMOUNT")).status, 400);
  assert.equal((await confirm(action.id, "CAPTURE-STREAM", token)).status, 401);
  capture(action, "CAPTURE-STREAM");
  assert.equal((await confirm(action.id, "CAPTURE-STREAM")).status, 200);
  const paid = await invoke<Action>(stream, "get_status", {
    action_id: action.id,
  });
  assert.equal(paid.status, "ACTIVE");
  assert.equal(paid.period_end, "2026-12-11T10:00:00.000Z");
  assert.equal(paid.cancel_effective_at, paid.period_end);
  assert.equal((await confirm(action.id, "CAPTURE-STREAM")).status, 200);
  assert.equal(
    merchant
      .outbox()
      .filter(
        (email) =>
          email.action_id === action.id && email.type === "confirmation",
      ).length,
    1,
  );
  const canceled = await invoke<Action>(stream, "cancel", {
    action_id: action.id,
    effective: "period_end",
    idempotency_key: "cancel-1",
  });
  assert.equal(canceled.status, "ACTIVE");
  assert.equal(canceled.cancel_effective_at, canceled.period_end);
  const coffee = await client("basil-market");
  await assert.rejects(
    invoke(coffee, "get_status", { action_id: action.id }),
    (e: unknown) =>
      e instanceof MerchantError && e.code === "SERVICE_SCOPE_MISMATCH",
  );
  await assert.rejects(
    invoke(stream, "get_plans", { service_id: "daily-paws" }),
    (e: unknown) =>
      e instanceof MerchantError && e.code === "SERVICE_SCOPE_MISMATCH",
  );
});

test("coffee and pet orders have exact quotes and cannot activate from MCP alone", async () => {
  const coffee = await client("basil-market");
  const q = await invoke<Quote>(coffee, "get_quote", {
    item_id: "coffee-250g",
    quantity: 2,
  });
  assert.equal(q.amount_minor, 1300);
  const action = await invoke<Action>(coffee, "place_order", {
    quote_id: q.id,
    address: "groceries@example.test",
    idempotency_key: "coffee-1",
  });
  assert.equal(action.status, "AWAITING_PAYMENT");
  const q2 = await invoke<Quote>(coffee, "get_quote", {
    item_id: "coffee-250g",
  });
  await assert.rejects(
    invoke(coffee, "place_order", {
      quote_id: q2.id,
      address: "groceries@example.test",
      idempotency_key: "coffee-1",
    }),
    (e: unknown) =>
      e instanceof MerchantError && e.code === "IDEMPOTENCY_CONFLICT",
  );
  capture(action, "CAPTURE-COFFEE");
  assert.equal((await confirm(action.id, "CAPTURE-COFFEE")).status, 200);
  assert.equal(
    (await invoke<Action>(coffee, "get_status", { action_id: action.id }))
      .status,
    "CONFIRMED",
  );
  const pets = await client("daily-paws");
  const petQuote = await invoke<Quote>(pets, "get_quote", {
    item_id: "dog-food-3kg",
  });
  assert.equal(petQuote.amount_minor, 2999);
  assert(
    !(await pets.listTools()).tools
      .map((tool) => tool.name)
      .includes("subscribe"),
  );
});

test("booking capacity is held atomically and late payment is not a confirmed table", async () => {
  const dining = await client("marina-table");
  const q = await invoke<Quote>(dining, "get_quote", {
    item_id: "friday-deposit",
    booking: { date: "2026-11-13", time: "19:00", party_size: 6 },
  });
  const booking = await invoke<Action>(dining, "book", {
    quote_id: q.id,
    address: "dining@example.test",
    idempotency_key: "booking-1",
  });
  const q2 = await invoke<Quote>(dining, "get_quote", {
    item_id: "friday-deposit",
    booking: { date: "2026-11-13", time: "19:00", party_size: 4 },
  });
  await assert.rejects(
    invoke(dining, "book", {
      quote_id: q2.id,
      address: "other@example.test",
      idempotency_key: "booking-2",
    }),
    (e: unknown) => e instanceof MerchantError && e.code === "SLOT_UNAVAILABLE",
  );
  time = new Date("2026-11-11T10:06:00Z");
  capture(booking, "LATE-BOOKING");
  assert.equal((await confirm(booking.id, "LATE-BOOKING")).status, 200);
  assert.equal(
    (await invoke<Action>(dining, "get_status", { action_id: booking.id }))
      .status,
    "PAID_REVIEW",
  );
  assert(
    !merchant
      .outbox()
      .some(
        (email) =>
          email.action_id === booking.id && email.type === "confirmation",
      ),
  );
  await assert.rejects(
    invoke(dining, "book", {
      quote_id: q2.id,
      address: "other@example.test",
      idempotency_key: "booking-expired",
    }),
    (e: unknown) => e instanceof MerchantError && e.code === "QUOTE_EXPIRED",
  );
  await assert.rejects(
    invoke(dining, "get_quote", {
      item_id: "friday-deposit",
      booking: { date: "2026-11-12", time: "19:00", party_size: 2 },
    }),
    (e: unknown) => e instanceof MerchantError && e.code === "INVALID_BOOKING",
  );
});

test("server rejects unauthorized, wrong-origin and malformed integration requests", async () => {
  assert.equal(
    (await fetch(`${base}/mcp`, { method: "POST", body: "{}" })).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          Authorization: `Bearer ${token}`,
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/internal/payments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}` },
        body: "not json",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${base}/internal/outbox`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  const tooLarge = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: "x".repeat(70_000),
  });
  assert.equal(tooLarge.status, 413);
});

test("paid subscription and one-time outbox persist and cancel at month end after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mailbox-mcp-"));
  const path = join(directory, "merchant.sqlite");
  let now = new Date("2026-01-31T12:00:00Z");
  let store = new Merchant(path, catalogue.services, "maya", () => now);
  try {
    const q = store.quote("coast-screen", "monthly");
    const action = store.prepare(
      "coast-screen",
      q.id,
      "stream@example.test",
      "persistent-1",
      "subscription",
    );
    await store.confirmCapture(action.id, "PERSIST-CAPTURE", async (id) => ({
      id,
      invoice_id: action.id,
      amount_minor: 799,
      currency: "USD",
      merchant_id: catalogue.services[0]!.paypalMerchant,
    }));
    assert.equal(
      store.status("coast-screen", action.id).period_end,
      "2026-02-28T12:00:00.000Z",
    );
    store.close();
    now = new Date("2026-03-01T00:00:00Z");
    store = new Merchant(path, catalogue.services, "maya", () => now);
    assert.equal(store.status("coast-screen", action.id).status, "CANCELED");
    store.settleDue();
    store.settleDue();
    assert.equal(
      store.outbox().filter((email) => email.type === "cancellation").length,
      1,
    );
    assert.equal(
      store.outbox().filter((email) => email.type === "confirmation").length,
      1,
    );
    const email = store.outbox()[0]!;
    store.acknowledgeEmail(email.id, "provider-real-id");
    assert.equal(store.outbox()[0]!.provider_message_id, "provider-real-id");
    assert.throws(
      () => store.acknowledgeEmail(email.id, "different-id"),
      /already/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(
    addBillingMonth("2028-01-31T01:02:03.000Z"),
    "2028-02-29T01:02:03.000Z",
  );
});

test("PayPal verifier requires completed capture, correct merchant, invoice and exact cents", async () => {
  let captureBody = {
    id: "REAL-CAPTURE",
    status: "COMPLETED",
    invoice_id: "action-id",
    amount: { value: "7.99", currency_code: "USD" },
    payee: { merchant_id: "MERCHANT" },
  };
  let calls = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls++;
    assert(url.startsWith("https://api-m.sandbox.paypal.com/"));
    if (url.endsWith("/oauth2/token")) {
      assert.equal(init?.body, "grant_type=client_credentials");
      return Response.json({ access_token: "test-access-token" });
    }
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-access-token",
    );
    return Response.json(captureBody);
  };
  const verify = paypalSandboxVerifier({
    clientId: "client",
    secret: "secret",
    merchantId: "MERCHANT",
    fetch: fakeFetch,
  });
  assert.deepEqual(await verify("REAL-CAPTURE"), {
    id: "REAL-CAPTURE",
    invoice_id: "action-id",
    amount_minor: 799,
    currency: "USD",
    merchant_id: "MERCHANT",
  });
  assert.equal(calls, 2);
  captureBody = { ...captureBody, status: "PENDING" };
  await assert.rejects(verify("REAL-CAPTURE"), /completed/);
  captureBody = {
    ...captureBody,
    status: "COMPLETED",
    payee: { merchant_id: "WRONG" },
  };
  await assert.rejects(verify("REAL-CAPTURE"), /merchant/);
});

test("realistic capture without payee is verified through its owning order", async () => {
  let wrongMerchant = false;
  const captureBody = {
    id: "NO-PAYEE-CAPTURE",
    status: "COMPLETED",
    invoice_id: "expected-action",
    amount: { currency_code: "USD", value: "7.99" },
    links: [
      {
        rel: "up",
        href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/OWNING-ORDER",
      },
    ],
  };
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/oauth2/token"))
      return Response.json({ access_token: "test" });
    if (url.endsWith("/captures/NO-PAYEE-CAPTURE"))
      return Response.json(captureBody);
    assert.equal(
      url,
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/OWNING-ORDER",
    );
    return Response.json({
      id: "OWNING-ORDER",
      purchase_units: [
        {
          invoice_id: "expected-action",
          payee: { merchant_id: wrongMerchant ? "WRONG" : "MERCHANT" },
          payments: {
            captures: [{ id: "NO-PAYEE-CAPTURE", status: "COMPLETED" }],
          },
        },
      ],
    });
  };
  const verify = paypalSandboxVerifier({
    clientId: "client",
    secret: "secret",
    merchantId: "MERCHANT",
    fetch: request,
  });
  assert.equal((await verify("NO-PAYEE-CAPTURE")).merchant_id, "MERCHANT");
  wrongMerchant = true;
  await assert.rejects(verify("NO-PAYEE-CAPTURE"), /merchant/);
});

test("verified PayPal webhook activates one prepared MCP subscription and queues one structured receipt", async () => {
  const stream = await client("harbor-play");
  const q = await invoke<Quote>(stream, "get_quote", { item_id: "monthly" });
  const action = await invoke<Action>(stream, "subscribe", {
    quote_id: q.id,
    address: "harbor@example.test",
    idempotency_key: "webhook-stream",
    paid_periods: 1,
  });
  capture(action, "WEBHOOK-CAPTURE");
  const event = {
    id: "event-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: "WEBHOOK-CAPTURE" },
  };
  const send = (signature: string) =>
    fetch(`${base}/webhooks/paypal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "paypal-transmission-sig": signature,
      },
      body: JSON.stringify(event),
    });
  assert.equal((await send("forged")).status, 401);
  assert.equal(
    (await invoke<Action>(stream, "get_status", { action_id: action.id }))
      .status,
    "AWAITING_PAYMENT",
  );
  assert.equal((await send("test-valid-signature")).status, 200);
  assert.equal((await send("test-valid-signature")).status, 200);
  assert.equal(
    (await invoke<Action>(stream, "get_status", { action_id: action.id }))
      .status,
    "ACTIVE",
  );
  const receipts = merchant
    .outbox()
    .filter(
      (email) => email.action_id === action.id && email.type === "confirmation",
    );
  assert.equal(receipts.length, 1);
  assert.match(receipts[0]!.text, /mailbox\.service-event\.v1/);
});

test("merchant SDK config creates another service without new lifecycle code", () => {
  const service = createService({
    id: "second-coffee",
    name: "Second Coffee",
    category: "groceries",
    paypalMerchant: "FIXTURE-MERCHANT",
    catalogue: [
      {
        id: "beans",
        name: "Beans 250 g",
        amount_minor: 575,
        period: "once",
        terms: "All-in sample price.",
      },
    ],
  });
  const host = new Merchant(":memory:", [service]);
  try {
    const q = host.quote(service.id, "beans");
    const action = host.prepare(
      service.id,
      q.id,
      "coffee@example.test",
      "sdk-variant",
      "purchase",
    );
    assert.equal(action.payment.amount.value, "5.75");
    assert.equal(action.status, "AWAITING_PAYMENT");
  } finally {
    host.close();
  }
});

test("sandbox webhook signature is posted back and never trusted from event JSON", async () => {
  let verified = false;
  const request: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/oauth2/token"))
      return Response.json({ access_token: "test" });
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.webhook_id, "registered-webhook");
    assert.equal(payload.transmission_sig, "signed");
    assert.deepEqual(payload.webhook_event, { id: "event" });
    return Response.json({
      verification_status: verified ? "SUCCESS" : "FAILURE",
    });
  };
  const verify = paypalSandboxWebhookVerifier({
    clientId: "client",
    secret: "secret",
    webhookId: "registered-webhook",
    fetch: request,
  });
  assert.equal(await verify({}, {}), false);
  const headers = {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
    "paypal-transmission-id": "transmission",
    "paypal-transmission-sig": "signed",
    "paypal-transmission-time": "2026-11-11T10:00:00Z",
  };
  assert.equal(await verify(headers, { id: "event" }), false);
  verified = true;
  assert.equal(await verify(headers, { id: "event" }), true);
});
