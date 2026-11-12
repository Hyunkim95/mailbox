import { test } from "node:test";
import assert from "node:assert/strict";
import { Merchant, createService, type Quote } from "@mailbox/service-sdk";
import { compareQuotes } from "../src/quote-comparison.ts";
import { catalogue } from "../src/catalogue.ts";
import { fixtureMessages } from "../src/seed.ts";

const now = new Date("2026-11-11T12:00:00Z");
function compare(quotes: Quote[], maxAmount: number | null = null) {
  return compareQuotes({
    quotes,
    offers: [],
    now,
    maxAmount,
    availableFor: () => 15000,
  });
}
function fresh() {
  const merchant = new Merchant(
    ":memory:",
    catalogue.services,
    "maya",
    () => now,
  );
  try {
    return [
      merchant.quote("basil-market", "coffee-250g", 1),
      merchant.quote("basil-market", "coffee-500g", 1),
    ];
  } finally {
    merchant.close();
  }
}

test("unit arithmetic uses delivered quote totals, quantities and scoped offers without selecting a winner", () => {
  const quotes = fresh();
  const result = compareQuotes({
    quotes,
    now,
    maxAmount: null,
    availableFor: () => 15000,
    offers: fixtureMessages("owner", now).filter(
      (m) => m.kind === "offer" && m.service_id === "basil-market",
    ),
  });
  assert.equal(result.comparison.selected_item_id, "");
  assert.equal(result.comparison.rows[0]!.unit_price, 2600);
  assert.equal(result.comparison.rows[1]!.unit_price, 2950);
  assert.equal(result.comparison.expired_offers, 1);
  assert(result.comparison.rows.every((row) => row.source_ids.length === 0));
  const doubled = compare(
    quotes.map((q) => ({
      ...q,
      quantity: 2,
      amount_minor: q.amount_minor * 2,
    })),
  );
  assert.equal(doubled.comparison.rows[0]!.unit_price, 2600);
  assert.match(doubled.comparison.rows[0]!.pack, /× 2/);
});

test("a new merchant and product group use the same comparison with no domain code", () => {
  const service = createService({
    id: "atelier-soap",
    name: "Atelier Soap",
    category: "household",
    paypalMerchant: "atelier",
    catalogue: [
      {
        id: "soap-small",
        name: "Cedar soap 200 ml",
        amount_minor: 450,
        period: "once",
        terms: "Delivered total",
        in_stock: true,
        unit_quantity: 200,
        unit: "ml",
        comparison_group: "cedar-hand-soap",
      },
      {
        id: "soap-large",
        name: "Cedar soap 500 ml",
        amount_minor: 800,
        period: "once",
        terms: "Delivered total",
        in_stock: true,
        unit_quantity: 500,
        unit: "ml",
        comparison_group: "cedar-hand-soap",
      },
    ],
  });
  const merchant = new Merchant(":memory:", [service], "maya", () => now);
  try {
    const quotes = service.items.map((i) =>
      merchant.quote(service.id, i.id, 1),
    );
    const result = compare(quotes, 600);
    assert.equal(result.comparison.rows[0]!.item_id, "soap-large");
    assert.equal(result.comparison.rows[0]!.eligible, false);
    assert.equal(result.comparison.rows[1]!.eligible, true);
    assert.equal(result.comparison.rows[0]!.unit_label, "L");
    const changed = compare(
      quotes.map((q) => ({
        ...q,
        amount_minor: q.item_id === "soap-large" ? 1300 : q.amount_minor,
      })),
    );
    assert.equal(changed.comparison.rows[0]!.item_id, "soap-small");
  } finally {
    merchant.close();
  }
});

test("unknown currency, incompatible variants, invalid amounts/units and expired quotes fail closed", () => {
  for (const patch of [
    { currency: "EUR" },
    { unit: "ml" },
    { unit_quantity: 0 },
    { unit_quantity: NaN },
    { quantity: 0 },
    { amount_minor: 0 },
    { amount_minor: 1.5 },
    { comparison_group: "unrelated" },
    { expires_at: now.toISOString() },
    { expires_at: "invalid" },
    { kind: "subscription" },
  ]) {
    const quotes = fresh();
    assert.throws(
      () => compare([quotes[0]!, { ...quotes[1]!, ...patch } as Quote]),
      /current purchase quotes/,
    );
  }
  assert.throws(() => compare([fresh()[0]!]), /two distinct/);
});

test("changing the available allowance marks every unaffordable total without authorizing payment", () => {
  const result = compareQuotes({
    quotes: fresh(),
    offers: [],
    now,
    maxAmount: null,
    availableFor: () => 500,
  });
  assert(result.comparison.rows.every((r) => !r.eligible));
  assert.equal(result.comparison.selected_service_id, "");
});
