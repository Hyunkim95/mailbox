import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { isMainThread } from "node:worker_threads";
import { AppStore } from "../../dist/src/app-store.js";
import { AppService } from "../../dist/src/app-service.js";
import { Merchant } from "@mailbox/service-sdk";
import { catalogue } from "../../dist/src/catalogue.js";
import { nextAgentTurn } from "../../dist/src/agent-model.js";

// Explicit test preload only. It changes provider transports, never app results,
// agent decisions, merchant fulfillment checks or financial policy enforcement.
if (isMainThread) {
  const liveSandbox =
    process.env.MAILBOX_REVIEW_TRANSPORTS === "real-paypal-preview-mail";
  assert(liveSandbox || process.env.MAILBOX_REVIEW_TRANSPORTS === "1");
  if (liveSandbox) {
    assert(
      process.env.PAYPAL_CLIENT_ID &&
        process.env.PAYPAL_CLIENT_ID !== "review-paypal-client",
    );
    assert(
      process.env.PAYPAL_CLIENT_SECRET &&
        process.env.PAYPAL_CLIENT_SECRET !== "review-paypal-secret",
    );
    assert(
      process.env.PAYPAL_MERCHANT_ID &&
        process.env.PAYPAL_MERCHANT_ID !== "REVIEW-MERCHANT",
    );
    assert.equal(process.env.MAILBOX_MAIL_PREVIEW, "1");
  } else {
    assert.equal(process.env.PAYPAL_CLIENT_ID, "review-paypal-client");
    assert.equal(process.env.PAYPAL_CLIENT_SECRET, "review-paypal-secret");
    assert.equal(process.env.PAYPAL_MERCHANT_ID, "REVIEW-MERCHANT");
  }
  assert.equal(process.env.AGENTMAIL_API_KEY, "review-agentmail-key");
  const db = resolve(process.env.APP_DATABASE_PATH);
  assert(
    db.includes(
      liveSandbox
        ? "/artifacts/provider-acceptance/"
        : "/artifacts/staged-review/",
    ),
  );
  const folder = dirname(db),
    clockFile = resolve(folder, "clock.json"),
    providerFile = resolve(folder, "providers.json");
  const now = () =>
    liveSandbox
      ? new Date()
      : new Date(JSON.parse(readFileSync(clockFile, "utf8")).now);
  const state = existsSync(providerFile)
    ? JSON.parse(readFileSync(providerFile, "utf8"))
    : {
        mode: liveSandbox
          ? "genuine PayPal sandbox; preview email"
          : "simulated providers",
        orders: {},
        captures: {},
        messages: {},
        attachments: {},
        sends: {},
        calls: [],
      };
  const persist = () =>
    writeFileSync(providerFile, JSON.stringify(state, null, 2));
  const json = (body, status = 200) => Response.json(body, { status });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url,
    );
    if (
      ![
        "api-m.sandbox.paypal.com",
        "api.agentmail.to",
        "review-attachments.mailbox.test",
      ].includes(url.hostname)
    )
      return originalFetch(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const raw =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request && method !== "GET"
          ? await input.clone().text()
          : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : {};
    state.calls.push({
      at: now().toISOString(),
      host: url.hostname,
      path:
        liveSandbox && url.pathname.startsWith("/v3/vault/")
          ? "/v3/vault/[redacted]"
          : url.pathname,
      method,
    });
    if (url.hostname === "api-m.sandbox.paypal.com") {
      if (liveSandbox) {
        persist();
        return originalFetch(input, init);
      }
      if (url.pathname === "/v1/oauth2/token")
        return json({
          access_token: "review-access",
          token_type: "Bearer",
          expires_in: 3600,
        });
      if (url.pathname === "/v2/checkout/orders" && method === "POST") {
        const key = headers.get("paypal-request-id");
        assert(key);
        assert.equal(body.purchase_units.length, 1);
        assert(
          String(body.payment_source?.paypal?.vault_id).startsWith("review-"),
        );
        let order = state.orders[key];
        if (!order) {
          const number = Object.keys(state.orders).length + 1,
            id = `STAGED-ORDER-${number}`,
            captureId = `STAGED-CAPTURE-${number}`,
            unit = body.purchase_units[0];
          assert.equal(unit.amount.currency_code, "USD");
          assert.equal(unit.payee.merchant_id, "REVIEW-MERCHANT");
          assert(/^\d+\.\d{2}$/.test(unit.amount.value));
          const capture = {
            id: captureId,
            status: "COMPLETED",
            amount: unit.amount,
            invoice_id: unit.invoice_id,
            supplementary_data: { related_ids: { order_id: id } },
          };
          order = {
            id,
            status: "COMPLETED",
            purchase_units: [{ ...unit, payments: { captures: [capture] } }],
          };
          state.orders[key] = order;
          state.captures[captureId] = capture;
          persist();
        }
        return json({ id: order.id, status: order.status });
      }
      const order = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(url.pathname);
      if (order) {
        const found = Object.values(state.orders).find(
          (o) => o.id === order[1],
        );
        persist();
        return found
          ? json(found)
          : json({ message: "Unknown staged order" }, 404);
      }
      const capture = /^\/v2\/payments\/captures\/([^/]+)$/.exec(url.pathname);
      if (capture) {
        persist();
        return state.captures[capture[1]]
          ? json(state.captures[capture[1]])
          : json({ message: "Unknown staged capture" }, 404);
      }
      throw Error(
        `Unexpected simulated PayPal request: ${method} ${url.pathname}`,
      );
    }
    if (url.hostname === "review-attachments.mailbox.test") {
      const id = url.pathname.slice(1),
        attachment = state.attachments[id];
      assert(attachment);
      const bytes = Buffer.from(attachment.content, "base64");
      persist();
      return new Response(bytes, {
        headers: {
          "content-type": attachment.content_type,
          "content-length": String(bytes.length),
        },
      });
    }
    const path = url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    assert.equal(path[0], "v0");
    assert.equal(path[1], "inboxes");
    const inbox = path[2];
    const replying =
      path[3] === "messages" && path[5] === "reply" && method === "POST";
    if (
      path[3] === "messages" &&
      ((path[4] === "send" && method === "POST") || replying)
    ) {
      const original = replying
        ? (state.messages[inbox] ?? []).find((m) => m.message_id === path[4])
        : null;
      if (replying)
        assert(
          original,
          "Reply must reference an actual received provider message",
        );
      const recipients =
        body.to ??
        (original?.reply_to?.length
          ? original.reply_to
          : original
            ? [original.from.match(/<([^>]+)>/)?.[1] ?? original.from]
            : []);
      const key = headers.get("idempotency-key");
      assert(key);
      if (state.sends[key]) return json(state.sends[key]);
      const number = Object.keys(state.sends).length + 1,
        messageId = `staged-message-${number}`,
        timestamp = now().toISOString();
      const attachments = (body.attachments ?? []).map((a, i) => {
        const attachmentId = `${messageId}-attachment-${i + 1}`,
          bytes = Buffer.from(a.content, "base64");
        state.attachments[attachmentId] = {
          content: a.content,
          content_type: a.content_type ?? "application/octet-stream",
        };
        return {
          attachment_id: attachmentId,
          filename: a.filename,
          content_type: a.content_type ?? "application/octet-stream",
          size: bytes.length,
        };
      });
      for (const to of recipients) {
        const message = {
          inbox_id: to,
          thread_id: original?.thread_id ?? messageId,
          message_id: messageId,
          labels: ["inbox"],
          timestamp,
          from: `${replying ? "Reply author" : "Mailbox Fixture Merchant"} <${inbox}>`,
          to: [to],
          subject: body.subject ?? `Re: ${original?.subject ?? ""}`,
          text: body.text,
          preview: (body.text ?? "").slice(0, 180),
          attachments,
          size: Buffer.byteLength(body.text ?? ""),
          created_at: timestamp,
          updated_at: timestamp,
        };
        (state.messages[to] ??= []).push(message);
      }
      const result = {
        message_id: messageId,
        thread_id: original?.thread_id ?? messageId,
      };
      state.sends[key] = result;
      persist();
      return json(result);
    }
    if (path[3] === "messages" && path.length === 4 && method === "GET") {
      const messages = state.messages[inbox] ?? [];
      persist();
      return json({
        count: messages.length,
        messages: [...messages].reverse(),
      });
    }
    if (path[3] === "messages" && path.length === 5 && method === "GET") {
      const found = (state.messages[inbox] ?? []).find(
        (m) => m.message_id === path[4],
      );
      persist();
      return found
        ? json(found)
        : json(
            { name: "NotFoundError", message: "Unknown staged message" },
            404,
          );
    }
    if (
      path[3] === "messages" &&
      path[5] === "attachments" &&
      method === "GET"
    ) {
      const attachment = state.attachments[path[6]];
      assert(attachment);
      persist();
      return json({
        attachment_id: path[6],
        download_url: `https://review-attachments.mailbox.test/${path[6]}`,
        size: Buffer.from(attachment.content, "base64").length,
        expires_at: new Date(now().getTime() + 3600_000).toISOString(),
      });
    }
    throw Error(
      `Unexpected simulated AgentMail request: ${method} ${url.pathname}`,
    );
  };
  const store = new AppStore(db, now);
  store.setSetting("merchant_sender", "merchant@review.mailbox.test");
  globalThis.mailboxApp = new AppService(
    store,
    undefined,
    undefined,
    async (context, history) => {
      const call = await nextAgentTurn(context, history);
      const path = resolve(folder, "agent-traces.json");
      const traces = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : [];
      const observed = history.at(-1);
      traces.push({
        at: now().toISOString(),
        request: context.request,
        agent_id: context.agent?.id,
        ...(observed
          ? {
              observation: {
                tool: observed.call.name,
                arguments: observed.call.arguments,
                result: observed.result,
              },
            }
          : {}),
        choice: { id: call.id, tool: call.name, arguments: call.arguments },
      });
      writeFileSync(path, JSON.stringify(traces, null, 2));
      return call;
    },
  );
  const catalogueFile = resolve(folder, "catalogue.json");
  const services = existsSync(catalogueFile)
    ? JSON.parse(readFileSync(catalogueFile, "utf8"))
    : catalogue.services;
  globalThis.mailboxMerchant = new Merchant(
    process.env.MOCK_DATABASE_PATH,
    services,
    "maya",
    now,
  );
  persist();
}
