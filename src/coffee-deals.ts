import {
  MerchantError,
  type Quote,
  type Service,
  type Item,
} from "@mailbox/service-sdk";
import type { Message, Proposal } from "./app-model.ts";
import { merchantTool } from "./service-connector.ts";
import { periodKey } from "./app-store.ts";

export async function findCoffeeDeal(input: {
  services: Service[];
  messages: Message[];
  now: Date;
  quantity: number;
  budgetFor: (serviceId: string) => number;
  maxAmount?: number | null;
  quote?: (
    serviceId: string,
    itemId: string,
    quantity: number,
  ) => Promise<Quote>;
}) {
  const candidates = input.services
    .filter((s) => s.category === "groceries" && s.kind === "purchase")
    .flatMap((service) =>
      service.items
        .filter((item) => /coffee/i.test(item.name) && item.period === "once")
        .map((item) => ({ service, item })),
    );
  if (!candidates.length)
    throw new MerchantError(
      "NO_COFFEE_SERVICES",
      "No connected service has a supported coffee item.",
    );
  const anchor = candidates[0]!.item,
    group = anchor.comparison_group;
  const compatible = candidates.filter(
    ({ item }) =>
      item.in_stock &&
      item.unit &&
      item.unit_quantity &&
      (group
        ? item.comparison_group === group && item.unit === anchor.unit
        : item.id === anchor.id),
  );
  const week = periodKey(
    { period: "week", timezone: "Asia/Dubai" },
    input.now,
  ).slice(5);
  const start = new Date(`${week}T00:00:00+04:00`);
  const serviceIds = new Set(candidates.map((c) => c.service.id));
  const offers = input.messages.filter(
    (m) =>
      m.kind === "offer" &&
      !m.facts.suspicious &&
      serviceIds.has(m.service_id) &&
      /coffee/i.test(m.facts.item ?? ""),
  );
  const expired = offers.filter(
    (m) => m.facts.expires && new Date(m.facts.expires) <= input.now,
  ).length;
  const valid = offers.filter(
    (m) =>
      new Date(m.received_at) >= start &&
      (!m.facts.expires || new Date(m.facts.expires) > input.now),
  );
  const quote =
    input.quote ??
    ((serviceId: string, itemId: string, quantity: number) =>
      merchantTool<Quote>(serviceId, "get_quote", {
        item_id: itemId,
        quantity,
      }));
  const verified: {
    service: Service;
    item: Item;
    quote: Quote;
    rate: number;
    size: number;
    sources: string[];
  }[] = [];
  for (const { service, item } of compatible) {
    let current: Quote;
    try {
      current = await quote(service.id, item.id, input.quantity);
    } catch {
      continue;
    }
    if (
      current.service_id !== service.id ||
      current.item_id !== item.id ||
      current.currency !== "USD" ||
      !Number.isSafeInteger(current.amount_minor) ||
      current.amount_minor <= 0 ||
      current.quantity !== input.quantity ||
      new Date(current.expires_at) <= input.now
    )
      continue;
    const size = current.unit_quantity ?? item.unit_quantity!,
      unit = current.unit ?? item.unit!;
    if (unit !== anchor.unit || !Number.isSafeInteger(size) || size <= 0)
      continue;
    const base = unit === "each" ? 1 : 1000,
      rate = (current.amount_minor * base) / (size * current.quantity);
    const sources = valid
      .filter(
        (m) =>
          m.service_id === service.id &&
          m.facts.amount_minor === current.amount_minor / current.quantity &&
          /coffee/i.test(m.facts.item ?? "") &&
          (m.facts.item ?? "")
            .toLowerCase()
            .replace(/\s+/g, "")
            .includes(`${size}${unit}`),
      )
      .map((m) => m.id);
    verified.push({ service, item, quote: current, rate, size, sources });
  }
  verified.sort((a, b) => {
    const left =
        BigInt(a.quote.amount_minor) *
        BigInt(b.size) *
        BigInt(b.quote.quantity),
      right =
        BigInt(b.quote.amount_minor) *
        BigInt(a.size) *
        BigInt(a.quote.quantity);
    return left < right
      ? -1
      : left > right
        ? 1
        : a.quote.amount_minor - b.quote.amount_minor ||
          a.item.id.localeCompare(b.item.id);
  });
  const eligible = verified.filter(
    (candidate) =>
      candidate.quote.amount_minor <=
      Math.min(
        input.budgetFor(candidate.service.id),
        input.maxAmount ?? Number.MAX_SAFE_INTEGER,
      ),
  );
  const best = eligible[0];
  if (!best)
    throw new MerchantError(
      "NO_ELIGIBLE_COFFEE_DEAL",
      "No current, comparable coffee quote fits the wallet limits.",
    );
  const merchantCount = new Set(verified.map((c) => c.service.paypalMerchant))
    .size;
  const comparison: NonNullable<Proposal["comparison"]> = {
    rows: verified.map((candidate) => ({
      service_id: candidate.service.id,
      item_id: candidate.item.id,
      label: candidate.item.name,
      pack: `${candidate.quote.unit_quantity ?? candidate.item.unit_quantity} ${candidate.quote.unit ?? candidate.item.unit}`,
      amount: candidate.quote.amount_minor,
      unit_price: candidate.rate,
      unit_label:
        candidate.item.unit === "g"
          ? "kg"
          : candidate.item.unit === "ml"
            ? "L"
            : "item",
      source_ids: candidate.sources,
      eligible:
        candidate.quote.amount_minor <=
        Math.min(
          input.budgetFor(candidate.service.id),
          input.maxAmount ?? Number.MAX_SAFE_INTEGER,
        ),
    })),
    selected_item_id: best.item.id,
    selected_service_id: best.service.id,
    expired_offers: expired,
    checked_at: input.now.toISOString(),
    scope: `${verified.length} current quotes from ${merchantCount} connected fixture ${merchantCount === 1 ? "merchant" : "merchants"}`,
  };
  return {
    serviceId: best.service.id,
    itemId: best.item.id,
    quote: best.quote,
    comparison,
    sources: best.sources,
    rationale: `Lowest verified unit price within your limits for the same coffee: $${(best.rate / 100).toFixed(2)}/${best.item.unit === "g" ? "kg" : best.item.unit === "ml" ? "L" : "item"}. Compared ${verified.length} pack quotes${expired ? `; excluded ${expired} expired email offer${expired === 1 ? "" : "s"}` : ""}.`,
  };
}
