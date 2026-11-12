import { MerchantError, type Quote } from "@mailbox/service-sdk";
import type { Message, Proposal } from "./app-model.ts";

/** Arithmetic and evidence checks only. The model chooses the candidate set and recommendation. */
export function compareQuotes(input: {
  quotes: Quote[];
  offers: Message[];
  now: Date;
  availableFor: (serviceId: string) => number;
  maxAmount: number | null;
}) {
  const quotes = [...new Map(input.quotes.map((q) => [q.id, q])).values()];
  const first = quotes[0];
  if (!first || quotes.length < 2)
    throw new MerchantError(
      "COMPARISON_REQUIRED",
      "Choose at least two distinct current quotes.",
    );
  for (const q of quotes) {
    if (
      q.kind !== "purchase" ||
      q.currency !== "USD" ||
      !q.comparison_group ||
      q.comparison_group !== first.comparison_group ||
      !q.unit ||
      q.unit !== first.unit ||
      !Number.isSafeInteger(q.unit_quantity) ||
      q.unit_quantity! <= 0 ||
      !Number.isSafeInteger(q.quantity) ||
      q.quantity <= 0 ||
      !Number.isSafeInteger(q.amount_minor) ||
      q.amount_minor <= 0 ||
      !(new Date(q.expires_at) > input.now)
    )
      throw new MerchantError(
        "QUOTES_NOT_COMPARABLE",
        "Use current purchase quotes for the same comparison group and unit, with valid pack sizes and quantities.",
      );
  }
  const offers = [...new Map(input.offers.map((m) => [m.id, m])).values()];
  if (
    offers.some(
      (m) =>
        m.kind !== "offer" ||
        m.facts.suspicious ||
        !quotes.some((q) => q.service_id === m.service_id),
    )
  )
    throw new MerchantError(
      "OFFER_NOT_COMPARABLE",
      "Use read, unblocked offers from the compared services.",
    );
  const expired = offers.filter(
    (m) => m.facts.expires && new Date(m.facts.expires) <= input.now,
  );
  const base = first.unit === "each" ? 1 : 1000;
  const ranked = [...quotes].sort((a, b) => {
    const left =
      BigInt(a.amount_minor) * BigInt(b.unit_quantity!) * BigInt(b.quantity);
    const right =
      BigInt(b.amount_minor) * BigInt(a.unit_quantity!) * BigInt(a.quantity);
    return left < right
      ? -1
      : left > right
        ? 1
        : a.amount_minor - b.amount_minor || a.id.localeCompare(b.id);
  });
  const comparison: NonNullable<Proposal["comparison"]> = {
    rows: ranked.map((q) => ({
      service_id: q.service_id,
      item_id: q.item_id,
      label: q.item_name,
      pack: `${q.unit_quantity} ${q.unit}${q.quantity === 1 ? "" : ` × ${q.quantity}`}`,
      amount: q.amount_minor,
      unit_price: (q.amount_minor * base) / (q.unit_quantity! * q.quantity),
      unit_label: q.unit === "g" ? "kg" : q.unit === "ml" ? "L" : "item",
      // An advertised price is not evidence for a newly fetched quote.
      source_ids: [],
      eligible:
        q.amount_minor <=
        Math.min(
          input.availableFor(q.service_id),
          input.maxAmount ?? Number.MAX_SAFE_INTEGER,
        ),
    })),
    selected_item_id: "",
    selected_service_id: "",
    expired_offers: expired.length,
    checked_at: input.now.toISOString(),
    scope: `${quotes.length} current quotes from ${new Set(quotes.map((q) => q.service_id)).size} connected fixture services`,
  };
  return {
    comparison,
    offer_checks: offers.map((m) => ({
      source_id: m.id,
      status: expired.includes(m) ? "expired" : "advertisement_only",
      reason: expired.includes(m)
        ? "Expired offer excluded; current merchant quotes determine the price."
        : "Email is context only; stock and all-in prices come from current merchant quotes.",
    })),
  };
}
