import { test } from "node:test";
import assert from "node:assert/strict";
import { Merchant, createService, type Service } from "@mailbox/service-sdk";
import { findCoffeeDeal } from "../src/coffee-deals.ts";
import { fixtureMessages } from "../src/seed.ts";
import { catalogue } from "../src/catalogue.ts";
const now = new Date("2026-11-11T12:00:00Z");
async function compare(services: Service[], budget = 15000) {
  const merchant = new Merchant(":memory:", services, "maya", () => now);
  try {
    return await findCoffeeDeal({
      services,
      messages: fixtureMessages("owner", now),
      now,
      quantity: 1,
      budgetFor: () => budget,
      quote: async (service, item, quantity) =>
        merchant.quote(service, item, quantity),
    });
  } finally {
    merchant.close();
  }
}
function coffee(price500 = 1475, inStock = true) {
  const original = catalogue.services.find((s) => s.id === "basil-market")!;
  return createService({
    id: original.id,
    name: original.name,
    category: original.category,
    paypalMerchant: original.paypalMerchant,
    catalogue: original.items.map((item) =>
      item.id === "coffee-500g"
        ? { ...item, amount_minor: price500, in_stock: inStock }
        : item,
    ),
  });
}
test("coffee comparison uses current merchant quotes, matching emails, unit prices and expiry", async () => {
  const deal = await compare([coffee()]);
  assert.equal(deal.itemId, "coffee-250g");
  assert.equal(deal.quote.amount_minor, 650);
  assert.equal(deal.comparison.rows.length, 2);
  assert.equal(deal.comparison.rows[0]!.unit_price, 2600);
  assert.equal(deal.comparison.rows[1]!.unit_price, 2950);
  assert.equal(deal.comparison.expired_offers, 1);
  assert.equal(deal.sources.length, 2);
  assert(!deal.sources.some((id) => id.endsWith("coffee-02")));
});
test("a cheaper verified unit price actually changes the proposed variant", async () => {
  const deal = await compare([coffee(999)]);
  assert.equal(deal.itemId, "coffee-500g");
  assert.equal(deal.quote.amount_minor, 999);
  assert.equal(deal.comparison.rows[0]!.unit_price, 1998);
  assert.equal(
    deal.sources.length,
    0,
    "old advertised price is not claimed as the current quote source",
  );
});
test("wallet bounds and stock exclude the apparently better deal", async () => {
  const budgeted = await compare([coffee(999)], 800);
  assert.equal(budgeted.itemId, "coffee-250g");
  assert.equal(
    budgeted.comparison.rows.find((row) => row.item_id === "coffee-500g")!
      .eligible,
    false,
  );
  const unavailable = await compare([coffee(999, false)]);
  assert.equal(unavailable.itemId, "coffee-250g");
  assert.equal(unavailable.comparison.rows.length, 1);
});
test("no eligible deal produces no payment proposal", async () => {
  await assert.rejects(compare([coffee()], 100), /fits the wallet limits/);
});
