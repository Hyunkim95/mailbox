import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { MerchantError, type Quote, type Service } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { MonthlyPurchaseRule, Proposal } from "./app-model.ts";

export const monthlyPurchaseInput = z
  .object({
    timezone: z.string().min(1).max(80),
    day_of_month: z.number().int().min(1).max(31),
    local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    starts_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    max_amount_minor: z.number().int().positive().max(100_000_000),
    price_inclusive: z.boolean(),
  })
  .strict();
export type MonthlyPurchaseInput = z.infer<typeof monthlyPurchaseInput>;

function zonedNow(rule: Pick<MonthlyPurchaseRule, "timezone">, now: Date) {
  return Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(
    rule.timezone,
  );
}
function dueInMonth(rule: MonthlyPurchaseRule, month: Temporal.PlainYearMonth) {
  const [hour, minute] = rule.local_time.split(":").map(Number);
  return Temporal.ZonedDateTime.from(
    {
      timeZone: rule.timezone,
      year: month.year,
      month: month.month,
      day: Math.min(rule.day_of_month, month.daysInMonth),
      hour: hour!,
      minute: minute!,
    },
    { disambiguation: "compatible" },
  );
}
/** Calendar months in the selected zone, with no automatic catch-up for missed months. */
export function monthlyDue(rule: MonthlyPurchaseRule, now: Date) {
  const local = zonedNow(rule, now);
  const month = Temporal.PlainYearMonth.from(local);
  const due = dueInMonth(rule, month);
  const at = new Date(due.epochMilliseconds);
  return {
    period: month.toString(),
    at: at.toISOString(),
    eligible:
      at >= new Date(rule.starts_at) &&
      now >= at &&
      now < new Date(rule.expires_at),
  };
}
export function nextMonthlyDue(
  rule: MonthlyPurchaseRule,
  now: Date,
  currentPeriodAttempted = false,
) {
  if (now >= new Date(rule.expires_at)) return null;
  const currentMonth = Temporal.PlainYearMonth.from(
    zonedNow(rule, now),
  ).toString();
  const pivot = new Date(
    Math.max(now.getTime(), new Date(rule.starts_at).getTime()),
  );
  let month = Temporal.PlainYearMonth.from(zonedNow(rule, pivot));
  for (let i = 0; i < 3; i++, month = month.add({ months: 1 })) {
    const due = dueInMonth(rule, month),
      at = new Date(due.epochMilliseconds);
    if (at >= new Date(rule.expires_at)) return null;
    if (month.toString() === currentMonth && currentPeriodAttempted) continue;
    if (
      at >= new Date(rule.starts_at) &&
      (at >= now ||
        (!currentPeriodAttempted && month.toString() === currentMonth))
    )
      return at.toISOString();
  }
  return null;
}
export function makeMonthlySchedule(
  quote: Quote,
  input: MonthlyPurchaseInput,
  now: Date,
): MonthlyPurchaseRule {
  const rule = monthlyPurchaseInput.parse(input);
  try {
    zonedNow(rule, now);
  } catch {
    throw new MerchantError(
      "INVALID_TIMEZONE",
      "Choose a valid schedule timezone.",
    );
  }
  if (
    new Date(rule.expires_at) <= now ||
    new Date(rule.starts_at) >= new Date(rule.expires_at)
  )
    throw new MerchantError(
      "INVALID_SCHEDULE",
      "Choose a start before a future schedule expiry.",
    );
  if (quote.kind !== "purchase")
    throw new MerchantError(
      "SCHEDULE_UNSUPPORTED",
      "Monthly purchase rules require an exact supported one-time product.",
    );
  const schedule: MonthlyPurchaseRule = {
    ...rule,
    item: {
      name: quote.item_name,
      terms: quote.terms,
      ...(quote.unit ? { unit: quote.unit } : {}),
      ...(quote.unit_quantity ? { unit_quantity: quote.unit_quantity } : {}),
      ...(quote.comparison_group
        ? { comparison_group: quote.comparison_group }
        : {}),
    },
    approved_at: null,
  };
  if (!nextMonthlyDue(schedule, now))
    throw new MerchantError(
      "NO_SCHEDULED_PERIOD",
      "The rule expires before its first eligible monthly purchase.",
    );
  return schedule;
}
export function scheduledPurchaseId(parentId: string, period: string) {
  const hex = createHash("sha256")
    .update(`monthly-purchase:${parentId}:${period}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function monthlyPeriodHasPurchase(
  store: AppStore,
  owner: string,
  parent: Proposal,
  now: Date,
) {
  if (!parent.monthly_schedule) return false;
  const period = monthlyDue(parent.monthly_schedule, now).period;
  return store
    .proposals(owner)
    .some(
      (p) =>
        p.scheduled_by &&
        p.agent_id === parent.agent_id &&
        p.service_id === parent.service_id &&
        p.item_id === parent.item_id &&
        ["PAID", "PAYING", "RECONCILING"].includes(p.status) &&
        Temporal.PlainYearMonth.from(
          zonedNow(
            parent.monthly_schedule!,
            new Date(p.dispatched_at ?? p.created_at),
          ),
        ).toString() === period,
    );
}
export function validateScheduledQuote(
  parent: Proposal,
  quote: Quote,
  service: Service,
  now: Date,
  enforcePrice = true,
) {
  const rule = parent.monthly_schedule;
  const item = service.items.find((i) => i.id === parent.item_id);
  if (!rule || service.id !== parent.service_id || !item || !item.in_stock)
    throw new MerchantError(
      "SCHEDULE_ITEM_UNAVAILABLE",
      "The exact approved product is unavailable. No substitution was ordered.",
    );
  if (
    quote.kind !== "purchase" ||
    quote.service_id !== parent.service_id ||
    quote.item_id !== parent.item_id ||
    quote.quantity !== parent.quantity ||
    quote.currency !== "USD" ||
    !Number.isSafeInteger(quote.amount_minor) ||
    quote.amount_minor <= 0 ||
    quote.item_name !== rule.item.name ||
    item.name !== rule.item.name ||
    quote.unit !== rule.item.unit ||
    quote.unit_quantity !== rule.item.unit_quantity ||
    quote.comparison_group !== rule.item.comparison_group ||
    !(new Date(quote.expires_at) > now)
  )
    throw new MerchantError(
      "SCHEDULE_ITEM_CHANGED",
      "The quote, variant or quantity differs from the approved rule. Review is required before any purchase.",
    );
  if (
    enforcePrice &&
    (rule.price_inclusive
      ? quote.amount_minor > rule.max_amount_minor
      : quote.amount_minor >= rule.max_amount_minor)
  )
    throw new MerchantError(
      "SCHEDULE_PRICE_LIMIT",
      `Current delivered quote: USD ${(quote.amount_minor / 100).toFixed(2)}. The rule allows ${rule.price_inclusive ? "up to" : "below"} USD ${(rule.max_amount_minor / 100).toFixed(2)}. Owner review is required; no order was placed.`,
    );
}
/** Rechecked inside the existing atomic wallet reservation, immediately before dispatch. */
export function assertScheduledDispatch(
  store: AppStore,
  owner: string,
  child: Proposal,
) {
  if (!child.scheduled_by) return;
  const parent = store.proposal(owner, child.scheduled_by.proposal_id),
    rule = parent.monthly_schedule;
  const wallet = store.wallet(owner, child.wallet_id);
  const agent = parent.agent_id ? store.agent(owner, parent.agent_id) : null;
  if (
    parent.kind !== "schedule" ||
    parent.status !== "WAITING" ||
    !rule?.approved_at ||
    parent.wallet_id !== child.wallet_id ||
    parent.agent_id !== child.agent_id ||
    parent.service_id !== child.service_id ||
    parent.item_id !== child.item_id ||
    parent.quantity !== child.quantity ||
    parent.wallet_revision !== wallet.revision ||
    !agent?.email ||
    !agent.inbox_id ||
    agent.status !== "connected" ||
    wallet.email !== agent.email ||
    wallet.inbox_id !== agent.inbox_id ||
    wallet.mode !== "auto" ||
    child.amount > wallet.auto_under ||
    child.id !== scheduledPurchaseId(parent.id, child.scheduled_by.period)
  )
    throw new MerchantError(
      "SCHEDULE_APPROVAL_REQUIRED",
      "This monthly purchase no longer matches an active standing approval.",
    );
  const due = monthlyDue(rule, store.now());
  if (!due.eligible || due.period !== child.scheduled_by.period)
    throw new MerchantError(
      "SCHEDULE_NOT_DUE",
      "This monthly purchase is not eligible in the current approved period.",
    );
  const siblings = store
    .proposals(owner)
    .filter(
      (p) =>
        p.id !== child.id &&
        p.scheduled_by &&
        p.agent_id === child.agent_id &&
        p.service_id === child.service_id &&
        p.item_id === child.item_id,
    );
  if (siblings.some((p) => ["PAYING", "RECONCILING"].includes(p.status)))
    throw new MerchantError(
      "SCHEDULE_PAYMENT_PENDING",
      "An earlier monthly purchase of this product still needs payment reconciliation.",
    );
  if (
    siblings.some(
      (p) =>
        p.status === "PAID" &&
        Temporal.PlainYearMonth.from(
          zonedNow(rule, new Date(p.dispatched_at ?? p.created_at)),
        ).toString() === due.period,
    )
  )
    throw new MerchantError(
      "SCHEDULE_PERIOD_ORDERED",
      "This product was already purchased under a monthly rule in the current period.",
    );
  if (
    rule.price_inclusive
      ? child.amount > rule.max_amount_minor
      : child.amount >= rule.max_amount_minor
  )
    throw new MerchantError(
      "SCHEDULE_PRICE_LIMIT",
      "This monthly purchase exceeds its approved delivered-price limit.",
    );
}
