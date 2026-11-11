import { test } from "node:test";
import assert from "node:assert/strict";
import { searchMarket } from "../src/market.ts";
import { studioTurn } from "../src/studio-model.ts";
import { fixtureMessages } from "../src/seed.ts";
import { dashboardData, defaultDashboard } from "../src/dashboard-data.ts";
import { AppStore } from "../src/app-store.ts";
import { AppService } from "../src/app-service.ts";
import { incomingService } from "../src/email.ts";

test("Channel3 search uses its SDK and returns priced, in-stock HTTPS offers without preparing purchases", async () => {
  const old = process.env.CHANNEL3_API_KEY;
  process.env.CHANNEL3_API_KEY = "fixture-channel3-key";
  try {
    const result = await searchMarket("coffee beans", async (input, init) => {
      assert.equal(String(input), "https://api.trychannel3.com/v1/search");
      assert.equal(
        new Headers(init?.headers).get("x-api-key"),
        "fixture-channel3-key",
      );
      const body = JSON.parse(String(init?.body));
      assert.equal(body.config.mode, "agentic");
      assert.equal(body.limit, 8);
      const offer = {
        url: "https://store.example.test/coffee",
        domain: "store.example.test",
        availability: "InStock",
        price: { price: 6.5, currency: "USD" },
      };
      return Response.json({
        products: [
          {
            id: "coffee",
            title: "Coffee beans",
            brands: [{ id: "brand", name: "Demo coffee" }],
            offers: [
              offer,
              { ...offer, url: "javascript:alert(1)" },
              { ...offer, availability: "OutOfStock" },
            ],
          },
        ],
      });
    });
    assert.equal(result.source, "Channel3");
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0]!.offers.length, 1);
    assert.equal(result.products[0]!.offers[0]!.amount, 6.5);
    assert.equal(result.type, "market");
    process.env.CHANNEL3_API_KEY = "your_channel3_api_key";
    await assert.rejects(
      searchMarket("coffee", async () => {
        throw Error("must not call");
      }),
      /Channel3 connection/,
    );
  } finally {
    if (old === undefined) delete process.env.CHANNEL3_API_KEY;
    else process.env.CHANNEL3_API_KEY = old;
  }
});
test("dashboard model proxy preserves native tool calls and never accepts provider-hosted tools", async () => {
  const names = ["AI_PROVIDER", "OPENAI_API_KEY"],
    previous = names.map((name) => process.env[name]);
  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "fixture-model-key";
  try {
    const turn = {
      input: [
        {
          id: "input",
          kind: "input",
          type: "message",
          role: "user",
          status: "completed",
          content: [{ type: "text", text: "Add a chart" }],
        },
      ],
      responseFormat: { type: "text" },
      tools: [
        {
          name: "add_widget",
          description: "Add an AG Studio widget",
          parameters: { type: "object", properties: {} },
          kind: "client",
        },
      ],
    };
    const result = await studioTurn(turn, async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.tools.length, 1);
      assert.equal(body.tools[0].name, "add_widget");
      assert.match(body.instructions, /never payments/);
      return Response.json({
        id: "response",
        status: "completed",
        output: [
          {
            id: "tool",
            type: "function_call",
            call_id: "call",
            name: "add_widget",
            arguments: '{"type":"grid"}',
          },
        ],
      });
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output[0]?.type, "function_call");
    await assert.rejects(
      studioTurn({ ...turn, tools: [{ ...turn.tools[0], kind: "provided" }] }),
      /Only dashboard tools/,
    );
  } finally {
    names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    });
  }
});
test("email variants retain HTML facts, unpaid invoices and risk flags without adding wallet spend", () => {
  const messages = fixtureMessages("owner");
  assert.equal(messages.length, 24);
  const html = messages.find(
    (m) => m.scenario === "HTML discount and cashback",
  )!;
  assert.equal(html.format, "html");
  assert.match(html.text, /PANTRY15/);
  assert.equal(html.facts.discount_percent, 15);
  assert.equal(html.facts.cashback_percent, 15);
  assert.equal(html.facts.expires, null);
  const invoice = messages.find((m) => m.kind === "invoice")!;
  assert.match(invoice.text, /UNPAID/);
  assert.equal(invoice.facts.amount_minor, 1000);
  assert.equal(
    messages.find((m) => m.id.endsWith("pets-06"))!.facts.suspicious,
    true,
  );
  const store = new AppStore(":memory:");
  try {
    for (const message of messages) store.saveMessage(message);
    const state = new AppService(store).state("owner");
    assert.equal(state.proposals.length, 0);
    assert.equal(state.wallets.length, 0);
    const data = dashboardData(state, "groceries");
    assert.equal(data.sources.length, 3);
    assert(!defaultDashboard(false).pages[0]!.widgets!.wallets);
  } finally {
    store.close();
  }
});
test("shared agent inboxes identify each service without treating an unrelated sender as a connected merchant", () => {
  const coffee = incomingService(
    "Your order. Mailbox fixture reference: coffee-01",
    "Fixture Merchant <merchant@example.test>",
  );
  const streaming = incomingService(
    '--- mailbox.service-event.v1 ---\n{"service_id":"coast-screen","type":"confirmation"}\n--- end mailbox.service-event.v1 ---',
    "Fixture Merchant <merchant@example.test>",
  );
  const unrelated = incomingService(
    "A grocery newsletter",
    "Another Store <news@another.example>",
  );
  assert.equal(coffee.service_id, "basil-market");
  assert.equal(streaming.service_id, "coast-screen");
  assert.match(unrelated.service_id, /^email:/);
});
