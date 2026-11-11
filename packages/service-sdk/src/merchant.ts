import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { addBillingMonth, MerchantError, type Service } from "./definition.js";
import type { CaptureVerifier, VerifiedCapture } from "./payments.js";

export type Booking = { date: string; time: string; party_size: number };
export type Quote = {
  id: string;
  service_id: string;
  item_id: string;
  item_name: string;
  quantity: number;
  amount_minor: number;
  currency: "USD";
  terms: string;
  created_at: string;
  expires_at: string;
  kind: "subscription" | "purchase" | "booking";
  booking?: Booking;
  unit_quantity?: number;
  unit?: "g" | "ml" | "each";
  comparison_group?: string;
};
export type Action = {
  id: string;
  service_id: string;
  customer_id: string;
  address: string;
  quote: Quote;
  status:
    "AWAITING_PAYMENT" | "ACTIVE" | "CONFIRMED" | "CANCELED" | "PAID_REVIEW";
  created_at: string;
  paid_at?: string;
  capture_id?: string;
  period_end?: string;
  renewal_disabled?: boolean;
  cancel_effective_at?: string;
  cancelled_at?: string;
  payment: {
    invoice_id: string;
    amount: { currency_code: "USD"; value: string };
  };
};
export type OutboundEmail = {
  id: string;
  action_id: string;
  type: string;
  to: string;
  subject: string;
  text: string;
  created_at: string;
  provider_message_id: string | null;
};

export class Merchant {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly services: Service[],
    readonly customerId = "maya",
    readonly now: () => Date = () => new Date(),
  ) {
    if (
      !services.length ||
      new Set(services.map((service) => service.id)).size !== services.length
    )
      throw new Error("Provide unique service IDs.");
    if (new Set(services.map((service) => service.paypalMerchant)).size !== 1)
      throw new Error("Run one merchant host per PayPal merchant account.");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, body TEXT NOT NULL, consumed_by TEXT);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, action_id TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, provider_message_id TEXT, UNIQUE(action_id,type));
      CREATE TABLE IF NOT EXISTS cancellation_requests (request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action_id TEXT NOT NULL);
    `);
    this.settleDue();
  }
  serviceById(id: string): Service {
    const service = this.services.find((s) => s.id === id);
    if (!service)
      throw new MerchantError("SERVICE_NOT_FOUND", "Unknown service.");
    return service;
  }
  close() {
    this.db.close();
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private save(action: Action) {
    this.db
      .prepare("UPDATE actions SET body=? WHERE id=?")
      .run(JSON.stringify(action), action.id);
  }
  private action(id: string): Action {
    const row = this.db.prepare("SELECT body FROM actions WHERE id=?").get(id);
    if (!row) throw new MerchantError("ACTION_NOT_FOUND", "Unknown action.");
    const action = JSON.parse(row.body as string) as Action;
    if (action.customer_id !== this.customerId)
      throw new MerchantError("ACTION_NOT_FOUND", "Unknown action.");
    return action;
  }
  private scoped(serviceId: string, id: string): Action {
    const action = this.action(id);
    if (action.service_id !== serviceId)
      throw new MerchantError(
        "SERVICE_SCOPE_MISMATCH",
        "Action belongs to another service.",
      );
    return action;
  }
  search(query = "", category?: string, serviceId?: string) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.services
      .filter((service) => {
        const haystack = JSON.stringify(service).toLowerCase();
        return (
          (!serviceId || service.id === serviceId) &&
          (!category || service.category === category) &&
          terms.every((term) => haystack.includes(term))
        );
      })
      .map((service) => ({
        ...service,
        fixture: true,
        currency: "USD",
        merchant: service.paypalMerchant,
      }));
  }
  getPlans(serviceId: string) {
    const service = this.serviceById(serviceId);
    return {
      ...service,
      fixture: true,
      currency: "USD",
      merchant: service.paypalMerchant,
      capabilities:
        service.kind === "subscription"
          ? ["quote", "subscribe", "cancel", "status"]
          : service.kind === "booking"
            ? ["quote", "book", "status"]
            : ["quote", "place_order", "status"],
    };
  }
  quote(
    serviceId: string,
    itemId: string,
    quantity = 1,
    booking?: Booking,
  ): Quote {
    const service = this.serviceById(serviceId);
    const item = service.items.find((item) => item.id === itemId);
    if (!item)
      throw new MerchantError("ITEM_NOT_FOUND", "Unknown plan or item.");
    if (!item.in_stock)
      throw new MerchantError(
        "OUT_OF_STOCK",
        "That variant is not currently available.",
      );
    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10 ||
      (service.kind !== "purchase" && quantity !== 1)
    )
      throw new MerchantError("INVALID_QUANTITY", "Unsupported quantity.");
    if (service.kind === "booking") {
      if (
        !booking ||
        !service.booking ||
        !/^\d{4}-\d{2}-\d{2}$/.test(booking.date) ||
        !service.booking.times.includes(booking.time) ||
        !Number.isInteger(booking.party_size) ||
        booking.party_size < 1 ||
        booking.party_size > service.booking.capacity
      )
        throw new MerchantError(
          "INVALID_BOOKING",
          "Choose a supported date, time and party size.",
        );
      const start = new Date(`${booking.date}T${booking.time}:00+04:00`);
      const localDay = new Date(`${booking.date}T00:00:00Z`);
      if (
        !Number.isFinite(start.getTime()) ||
        localDay.toISOString().slice(0, 10) !== booking.date ||
        localDay.getUTCDay() !== service.booking.weekday ||
        start <= this.now()
      )
        throw new MerchantError(
          "INVALID_BOOKING",
          "Choose a future Friday in Asia/Dubai.",
        );
    } else if (booking)
      throw new MerchantError(
        "INVALID_BOOKING",
        "This service does not accept bookings.",
      );
    const now = this.now();
    if (!Number.isSafeInteger(item.amount_minor * quantity))
      throw new MerchantError(
        "INVALID_AMOUNT",
        "Quoted amount is outside the supported integer range.",
      );
    const quote: Quote = {
      id: randomUUID(),
      service_id: serviceId,
      item_id: item.id,
      item_name: item.name,
      quantity,
      amount_minor: item.amount_minor * quantity,
      currency: "USD",
      terms: item.terms,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 300_000).toISOString(),
      kind: service.kind,
      ...(item.unit_quantity ? { unit_quantity: item.unit_quantity } : {}),
      ...(item.unit ? { unit: item.unit } : {}),
      ...(item.comparison_group
        ? { comparison_group: item.comparison_group }
        : {}),
      ...(booking ? { booking } : {}),
    };
    this.db
      .prepare("INSERT INTO quotes(id,service_id,body) VALUES(?,?,?)")
      .run(quote.id, serviceId, JSON.stringify(quote));
    return quote;
  }
  prepare(
    serviceId: string,
    quoteId: string,
    address: string,
    requestKey: string,
    kind: Quote["kind"],
  ): Action {
    if (
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ||
      address.length > 254
    )
      throw new MerchantError(
        "INVALID_ADDRESS",
        "Provide a receiving service address.",
      );
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(requestKey))
      throw new MerchantError(
        "INVALID_REQUEST_KEY",
        "Use a stable request ID.",
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ serviceId, quoteId, address, kind }))
      .digest("hex");
    return this.transaction(() => {
      const prior = this.db
        .prepare("SELECT id,fingerprint FROM actions WHERE request_key=?")
        .get(`${this.customerId}:${requestKey}`);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new MerchantError(
            "IDEMPOTENCY_CONFLICT",
            "This request ID was used with different terms.",
          );
        return this.action(prior.id as string);
      }
      const row = this.db
        .prepare("SELECT * FROM quotes WHERE id=?")
        .get(quoteId);
      if (!row) throw new MerchantError("QUOTE_NOT_FOUND", "Unknown quote.");
      const quote = JSON.parse(row.body as string) as Quote;
      if (quote.service_id !== serviceId || quote.kind !== kind)
        throw new MerchantError(
          "SERVICE_SCOPE_MISMATCH",
          "Quote does not match this action and service.",
        );
      if (row.consumed_by) {
        const existing = this.action(row.consumed_by as string);
        if (existing.address !== address)
          throw new MerchantError(
            "QUOTE_CONSUMED",
            "Quote was already used for another address.",
          );
        return existing;
      }
      if (new Date(quote.expires_at) <= this.now())
        throw new MerchantError("QUOTE_EXPIRED", "Request a fresh quote.");
      this.assertCapacity(quote);
      const id = randomUUID();
      const action: Action = {
        id,
        service_id: serviceId,
        customer_id: this.customerId,
        address,
        quote,
        status: "AWAITING_PAYMENT",
        created_at: this.now().toISOString(),
        payment: {
          invoice_id: id,
          amount: {
            currency_code: "USD",
            value: (quote.amount_minor / 100).toFixed(2),
          },
        },
        ...(kind === "subscription" ? { renewal_disabled: true } : {}),
      };
      this.db
        .prepare(
          "INSERT INTO actions(id,service_id,request_key,fingerprint,body) VALUES(?,?,?,?,?)",
        )
        .run(
          id,
          serviceId,
          `${this.customerId}:${requestKey}`,
          fingerprint,
          JSON.stringify(action),
        );
      this.db
        .prepare("UPDATE quotes SET consumed_by=? WHERE id=?")
        .run(id, quoteId);
      return action;
    });
  }
  private assertCapacity(quote: Quote) {
    if (!quote.booking) return;
    const service = this.serviceById(quote.service_id);
    let occupied = 0;
    for (const row of this.db
      .prepare("SELECT body FROM actions WHERE service_id=?")
      .all(quote.service_id)) {
      const action = JSON.parse(row.body as string) as Action;
      const booking = action.quote.booking;
      const liveHold =
        action.status === "AWAITING_PAYMENT" &&
        new Date(action.quote.expires_at) > this.now();
      if (
        booking?.date === quote.booking.date &&
        booking.time === quote.booking.time &&
        (action.status === "CONFIRMED" || liveHold)
      )
        occupied += booking.party_size;
    }
    if (occupied + quote.booking.party_size > (service.booking?.capacity ?? 0))
      throw new MerchantError(
        "SLOT_UNAVAILABLE",
        "That table slot is full. Choose another time.",
      );
  }
  async confirmCapture(
    actionId: string,
    captureId: string,
    verify: CaptureVerifier,
    orderId?: string,
  ): Promise<Action> {
    const observed = this.action(actionId);
    if (observed.capture_id === captureId) return observed;
    const capture: VerifiedCapture = await verify(captureId, orderId);
    return this.transaction(() => {
      const action = this.action(actionId);
      if (action.capture_id) {
        if (action.capture_id === captureId) return action;
        throw new MerchantError(
          "ALREADY_PAID",
          "This action already has a completed capture.",
        );
      }
      if (
        capture.id !== captureId ||
        capture.invoice_id !== action.id ||
        capture.amount_minor !== action.quote.amount_minor ||
        capture.currency !== action.quote.currency ||
        capture.merchant_id !==
          this.serviceById(action.service_id).paypalMerchant
      )
        throw new MerchantError(
          "CAPTURE_MISMATCH",
          "Capture does not match the merchant, action invoice and amount.",
        );
      const claimed = this.db
        .prepare("SELECT action_id FROM captures WHERE id=?")
        .get(captureId);
      if (claimed)
        throw new MerchantError(
          "CAPTURE_REUSED",
          "This capture already belongs to another action.",
        );
      const late =
        action.status === "CANCELED" ||
        (action.quote.kind === "booking" &&
          new Date(action.quote.expires_at) <= this.now());
      action.capture_id = captureId;
      action.paid_at = this.now().toISOString();
      action.status = late
        ? "PAID_REVIEW"
        : action.quote.kind === "subscription"
          ? "ACTIVE"
          : "CONFIRMED";
      if (action.quote.kind === "subscription" && !late) {
        action.period_end = addBillingMonth(action.paid_at);
        action.cancel_effective_at = action.period_end;
      }
      const item = this.serviceById(action.service_id).items.find(
        (item) => item.id === action.quote.item_id,
      );
      if (!late && action.quote.kind === "purchase" && item?.access_hours)
        action.period_end = new Date(
          new Date(action.paid_at).getTime() + item.access_hours * 3600_000,
        ).toISOString();
      this.db
        .prepare("INSERT INTO captures(id,action_id,body) VALUES(?,?,?)")
        .run(captureId, actionId, JSON.stringify(capture));
      this.save(action);
      this.email(action, late ? "payment_review" : "confirmation");
      return action;
    });
  }
  cancel(
    serviceId: string,
    actionId: string,
    effective: "period_end" | "immediate",
    requestKey: string,
  ): Action {
    this.serviceById(serviceId);
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(requestKey))
      throw new MerchantError(
        "INVALID_REQUEST_KEY",
        "Use a stable request ID.",
      );
    const fingerprint = JSON.stringify({ serviceId, actionId, effective });
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT fingerprint FROM cancellation_requests WHERE request_key=?",
        )
        .get(`${this.customerId}:${requestKey}`);
      if (prior && prior.fingerprint !== fingerprint)
        throw new MerchantError(
          "IDEMPOTENCY_CONFLICT",
          "Cancellation request ID was reused.",
        );
      const action = this.scoped(serviceId, actionId);
      if (action.quote.kind !== "subscription")
        throw new MerchantError(
          "UNSUPPORTED_OPERATION",
          "Only subscriptions can be canceled with this tool.",
        );
      if (prior || action.status === "CANCELED") return action;
      if (action.status === "PAID_REVIEW")
        throw new MerchantError(
          "PAYMENT_REVIEW",
          "Resolve the payment before changing access.",
        );
      action.renewal_disabled = true;
      if (effective === "immediate" || action.status === "AWAITING_PAYMENT") {
        action.status = "CANCELED";
        action.cancelled_at = this.now().toISOString();
        action.cancel_effective_at = action.cancelled_at;
      } else {
        if (!action.period_end)
          throw new MerchantError(
            "INVALID_SUBSCRIPTION_STATE",
            "Paid subscription period is missing.",
          );
        action.cancel_effective_at = action.period_end;
      }
      this.save(action);
      this.db
        .prepare(
          "INSERT INTO cancellation_requests(request_key,fingerprint,action_id) VALUES(?,?,?)",
        )
        .run(`${this.customerId}:${requestKey}`, fingerprint, actionId);
      this.email(
        action,
        action.status === "CANCELED"
          ? "cancellation"
          : "cancellation_scheduled",
      );
      return action;
    });
  }
  status(serviceId: string, actionId: string) {
    this.settleDue();
    return this.scoped(serviceId, actionId);
  }
  settleDue() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT body FROM actions").all()) {
        const action = JSON.parse(row.body as string) as Action;
        if (
          action.customer_id === this.customerId &&
          action.status === "ACTIVE" &&
          action.cancel_effective_at &&
          new Date(action.cancel_effective_at) <= this.now()
        ) {
          action.status = "CANCELED";
          action.cancelled_at = action.cancel_effective_at;
          this.save(action);
          this.email(action, "cancellation");
        }
      }
    });
  }
  private email(action: Action, type: string) {
    const service = this.serviceById(action.service_id);
    const text =
      type === "confirmation"
        ? `${service.name}: ${action.quote.item_name} confirmed. USD ${action.payment.amount.value} paid. Reference ${action.id}.${action.period_end ? ` Access ends ${action.period_end}. Renewal disabled; cancellation effective then.` : ""}${action.quote.booking ? ` Booking ${action.quote.booking.date} ${action.quote.booking.time} Asia/Dubai for ${action.quote.booking.party_size}.` : ""}`
        : type === "payment_review"
          ? `Payment ${action.capture_id} received after cancellation or slot expiry. Action ${action.id} requires review; no automatic fulfillment.`
          : `${service.name}: ${type === "cancellation_scheduled" ? "cancellation scheduled" : "subscription canceled"} for ${action.id}, effective ${action.cancel_effective_at}. No renewal charge is authorized.`;
    const event = {
      schema: "mailbox.service-event.v1",
      service_id: action.service_id,
      action_id: action.id,
      type,
      status: action.status,
      amount_minor: action.quote.amount_minor,
      currency: action.quote.currency,
      item: action.quote.item_name,
      quantity: action.quote.quantity,
      period_end: action.period_end ?? null,
      cancel_effective_at: action.cancel_effective_at ?? null,
      booking: action.quote.booking ?? null,
    };
    const structuredText = `${text}\n\n--- mailbox.service-event.v1 ---\n${JSON.stringify(event)}\n--- end mailbox.service-event.v1 ---`;
    const email: OutboundEmail = {
      id: randomUUID(),
      action_id: action.id,
      type,
      to: action.address,
      subject: `${service.name}: ${type.replaceAll("_", " ")}`,
      text: structuredText,
      created_at: this.now().toISOString(),
      provider_message_id: null,
    };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO outbox(id,action_id,type,body) VALUES(?,?,?,?)",
      )
      .run(email.id, action.id, type, JSON.stringify(email));
  }
  outbox(): OutboundEmail[] {
    return this.db
      .prepare("SELECT body,provider_message_id FROM outbox ORDER BY rowid")
      .all()
      .map((row) => ({
        ...(JSON.parse(row.body as string) as OutboundEmail),
        provider_message_id: row.provider_message_id as string | null,
      }));
  }
  acknowledgeEmail(id: string, providerId: string) {
    const row = this.db
      .prepare("SELECT provider_message_id FROM outbox WHERE id=?")
      .get(id);
    if (!row)
      throw new MerchantError("EMAIL_NOT_FOUND", "Unknown outbox email.");
    if (row.provider_message_id && row.provider_message_id !== providerId)
      throw new MerchantError(
        "EMAIL_ALREADY_SENT",
        "This email already has a provider message ID.",
      );
    this.db
      .prepare("UPDATE outbox SET provider_message_id=? WHERE id=?")
      .run(providerId, id);
  }
}
