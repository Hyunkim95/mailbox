import { randomUUID } from "node:crypto";
import {
  MerchantError,
  type Action,
  type Quote,
  type Service,
} from "@mailbox/service-sdk";
import { AppStore, periodKey } from "./app-store.ts";
import {
  configured,
  interpretAsk,
  modelName,
  modelReady,
  type AskIntent,
} from "./ai.ts";
import type { AppState, Proposal, Wallet } from "./app-model.ts";
import { merchantTool } from "./service-connector.ts";
import { PayPal } from "./paypal.ts";
import { deliverOutbox, provisionAddress, syncInbox } from "./email.ts";
import { catalogue } from "./catalogue.ts";
import { findCoffeeDeal } from "./coffee-deals.ts";
import { encryptToken, decryptToken } from "./token-vault.ts";

export class AppService {
  constructor(
    readonly store: AppStore,
    readonly paypal = new PayPal(),
    readonly mail = { provisionAddress, deliverOutbox, syncInbox },
  ) {}
  state(owner: string): AppState {
    return {
      wallets: this.store
        .wallets(owner)
        .map((w) => this.store.publicWallet(owner, w)),
      proposals: this.store.proposals(owner),
      messages: this.store.messages(owner),
      audit: this.store.audit(owner),
      configuration: {
        paypal:
          configured("PAYPAL_CLIENT_ID") &&
          configured("PAYPAL_CLIENT_SECRET") &&
          configured("PAYPAL_MERCHANT_ID"),
        email: configured("AGENTMAIL_API_KEY"),
        model: modelReady(),
        merchant: configured("MOCK_MERCHANT_TOKEN"),
      },
      model_name: modelName(),
      fixture_data: true,
    };
  }
  async services(query = "") {
    return merchantTool<Service[]>(null, "search_catalogue", { query });
  }
  private service(id: string) {
    const service = catalogue.services.find((s) => s.id === id);
    if (!service)
      throw new MerchantError(
        "UNSUPPORTED_SERVICE",
        "Choose one of the connected fixture services.",
      );
    return service;
  }
  async ask(owner: string, text: string, example?: string) {
    if (text.length < 1 || text.length > 1500)
      throw new MerchantError(
        "INVALID_ASK",
        "Enter a request up to 1,500 characters.",
      );
    const services = await this.services();
    let intent: AskIntent;
    if (example && !modelReady()) {
      const today = this.store.now();
      const local = new Date(today.getTime() + 4 * 60 * 60 * 1000);
      const weekday = local.getUTCDay();
      let delta = (5 - weekday + 7) % 7;
      if (delta === 0 && local.getUTCHours() >= 19) delta = 7;
      local.setUTCDate(local.getUTCDate() + delta);
      const date = local.toISOString().slice(0, 10);
      const known: Record<string, AskIntent["intent"]> = {
        film: "film",
        coffee: "coffee",
        dining: "booking",
        pets: "pets_condition",
      };
      const kind = known[example];
      if (!kind)
        throw new MerchantError(
          "MODEL_NOT_CONFIGURED",
          "Use a displayed fixture example or add the model key.",
        );
      intent = {
        intent: kind,
        query: kind === "film" ? "The Lantern Coast" : text,
        service_id: null,
        answer: null,
        date: kind === "booking" ? date : null,
        time: kind === "booking" ? "19:00" : null,
        party_size: kind === "booking" ? 2 : null,
        quantity: 1,
        under_minor: kind === "pets_condition" ? 3000 : null,
      };
    } else
      intent = await interpretAsk(text, {
        date: this.store.now().toISOString(),
        timezone: "Asia/Dubai",
        services,
        wallets: this.state(owner).wallets,
        messages: this.store
          .messages(owner)
          .slice(0, 30)
          .map((m) => ({
            id: m.id,
            service_id: m.service_id,
            subject: m.subject,
            facts: m.facts,
          })),
      });
    const engine = example && !modelReady() ? "fixture" : "model";
    this.store.log(
      owner,
      "REQUEST_INTERPRETED",
      engine === "fixture"
        ? "Explicit fixture walkthrough; no model call."
        : "Request interpreted with structured model output.",
    );
    if (intent.intent === "film") {
      const matches = await this.services(intent.query || "The Lantern Coast");
      if (!matches.length)
        return {
          type: "answer",
          answer:
            "No supported fixture service lists that film. I have not assumed it is available or prepared a payment.",
          sources: [],
          engine,
        };
      const already = this.store
        .proposals(owner)
        .find(
          (p) =>
            p.status === "PAID" &&
            (!p.cancel_effective_at ||
              new Date(p.cancel_effective_at) > this.store.now()) &&
            this.store.wallet(owner, p.wallet_id).status !== "canceled" &&
            matches.some((s) => s.id === p.service_id) &&
            (!p.period_end || new Date(p.period_end) > this.store.now()),
        );
      if (already)
        return {
          type: "answer",
          answer:
            "You already have access through this service. No additional payment is needed.",
          service_id: already.service_id,
          sources: this.store
            .messages(owner, already.service_id)
            .filter((m) => m.facts.action_id === already.merchant_action_id)
            .map((m) => m.id),
          engine,
        };
      return {
        type: "options",
        title: `${matches.length === 3 ? "Three" : matches.length} ways to watch ${matches[0]?.items[0]?.includes[0] ?? intent.query}`,
        options: matches.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          amount: s.items[0]!.amount_minor,
          item_id: s.items[0]!.id,
          terms: s.items[0]!.terms,
          category: s.category,
        })),
        engine,
      };
    }
    if (intent.intent === "coffee") {
      const deal = await findCoffeeDeal({
        services,
        messages: this.store.messages(owner),
        now: this.store.now(),
        quantity: intent.quantity ?? 1,
        maxAmount: intent.under_minor,
        budgetFor: (serviceId) => {
          const wallet = this.store
            .wallets(owner)
            .find((w) => w.service_id === serviceId);
          return wallet
            ? Math.min(
                this.store.publicWallet(owner, wallet).available,
                wallet.per_action,
              )
            : 15000;
        },
      });
      return {
        type: "proposal",
        proposal: await this.propose(owner, deal.serviceId, "buy", {
          quantity: intent.quantity ?? 1,
          item_id: deal.itemId,
          quote: deal.quote,
          comparison: deal.comparison,
          sources: deal.sources,
          rationale: deal.rationale,
        }),
        engine,
      };
    }
    if (intent.intent === "booking") {
      if (!intent.date || !intent.time || !intent.party_size)
        return {
          type: "answer",
          answer:
            intent.answer || "What time and how many people should I book for?",
          sources: [],
          engine,
        };
      return {
        type: "proposal",
        proposal: await this.propose(owner, "marina-table", "book", {
          booking: {
            date: intent.date,
            time: intent.time,
            party_size: intent.party_size,
          },
        }),
        engine,
      };
    }
    if (intent.intent === "pets_condition")
      return {
        type: "proposal",
        proposal: await this.propose(owner, "daily-paws", "condition", {
          quantity: intent.quantity ?? 1,
          under: intent.under_minor ?? 3000,
        }),
        engine,
      };
    if (intent.intent === "delivery") {
      const service = intent.service_id;
      const messages = this.store
        .messages(owner, service ?? undefined)
        .filter((m) => m.origin === "agentmail");
      return {
        type: "answer",
        answer:
          messages[0]?.text.split("\n\n---")[0] ??
          "There is no received delivery confirmation yet. I will keep the service status pending rather than guess.",
        sources: messages.slice(0, 2).map((m) => m.id),
        engine,
      };
    }
    if (intent.intent === "cancel")
      return {
        type: "answer",
        answer:
          "Open the streaming service and choose Cancel subscription to review its effective date.",
        sources: [],
        engine,
      };
    return {
      type: "answer",
      answer:
        intent.answer ||
        "This demo supports the fictional film, coffee offers, marina table bookings and dog-food restocking. Try one of those requests.",
      sources: [],
      engine,
    };
  }
  async propose(
    owner: string,
    serviceId: string,
    requested: "subscribe" | "buy" | "book" | "condition",
    options: {
      quantity?: number;
      booking?: Proposal["booking"];
      under?: number;
      item_id?: string;
      quote?: Quote;
      comparison?: Proposal["comparison"];
      sources?: string[];
      rationale?: string;
    } = {},
  ): Promise<Proposal> {
    const service = this.service(serviceId);
    const item = options.item_id
      ? service.items.find((item) => item.id === options.item_id)
      : service.items[0];
    if (!item)
      throw new MerchantError(
        "ITEM_NOT_FOUND",
        "Choose a supported item or plan.",
      );
    const kind =
      requested === "condition"
        ? "condition"
        : service.kind === "subscription"
          ? "subscribe"
          : service.kind === "booking"
            ? "book"
            : "buy";
    const wallet = this.store.ensureWallet(owner, service);
    const quote =
      options.quote ??
      (await merchantTool<Quote>(serviceId, "get_quote", {
        item_id: item.id,
        quantity: options.quantity ?? 1,
        ...(options.booking ? { booking: options.booking } : {}),
      }));
    const now = this.store.now().toISOString();
    const proposal: Proposal = {
      id: randomUUID(),
      owner,
      service_id: serviceId,
      wallet_id: wallet.id,
      kind,
      title:
        kind === "subscribe"
          ? `One month of ${service.name}`
          : kind === "book"
            ? "Reserve a table near the marina"
            : kind === "condition"
              ? "Restock dog food when the price drops"
              : quote.item_name,
      rationale:
        kind === "subscribe"
          ? "One paid month. Renewal disabled, with cancellation at the end of the paid period."
          : kind === "condition"
            ? `Buy this exact variant once when its all-in price is below $${((options.under ?? 3000) / 100).toFixed(2)}.`
            : quote.terms,
      amount: quote.amount_minor,
      quantity: quote.quantity,
      item_id: quote.item_id,
      quote_id: quote.id,
      quote_expires: quote.expires_at,
      wallet_revision: wallet.revision,
      merchant_action_id: null,
      status: "NEEDS_APPROVAL",
      reason: null,
      reserved: 0,
      period_key: null,
      paypal_order_id: null,
      capture_id: null,
      booking: options.booking ?? null,
      condition_under: kind === "condition" ? (options.under ?? 3000) : null,
      condition_expires:
        kind === "condition"
          ? new Date(this.store.now().getTime() + 7 * 86400_000).toISOString()
          : null,
      period_end: null,
      cancel_effective_at: null,
      sources: this.store
        .messages(owner, serviceId)
        .filter(
          (m) =>
            !m.facts.suspicious &&
            (!m.facts.expires ||
              new Date(m.facts.expires) > this.store.now()) &&
            m.facts.item
              ?.toLowerCase()
              .includes(kind === "condition" ? "dog" : "coffee") &&
            (kind === "condition" ||
              m.facts.amount_minor === quote.amount_minor / quote.quantity),
        )
        .slice(0, 3)
        .map((m) => m.id),
      created_at: now,
      updated_at: now,
    };
    if (options.rationale) proposal.rationale = options.rationale;
    if (options.sources) proposal.sources = options.sources;
    if (options.comparison) proposal.comparison = options.comparison;
    if (
      kind === "condition" &&
      (!Number.isInteger(proposal.condition_under) ||
        proposal.condition_under! <= 0)
    )
      throw new MerchantError(
        "INVALID_BOUND",
        "Choose a positive price condition.",
      );
    this.store.saveProposal(proposal);
    this.store.log(
      owner,
      "PROPOSAL_CREATED",
      proposal.rationale,
      serviceId,
      proposal.amount,
    );
    return proposal;
  }
  updateRules(
    owner: string,
    walletId: string,
    input: {
      revision: number;
      cap: number;
      per_action: number;
      auto_under: number;
      daily_limit: number;
      mode: Wallet["mode"];
      paused?: boolean | undefined;
      period?: Wallet["period"] | undefined;
      timezone?: string | undefined;
      expires_at?: string | undefined;
    },
  ) {
    return this.store.transaction(() => {
      const wallet = this.store.wallet(owner, walletId);
      if (wallet.revision !== input.revision)
        throw new MerchantError(
          "RULES_CHANGED",
          "These wallet rules changed. Reload before saving.",
        );
      if (
        ![
          input.cap,
          input.per_action,
          input.auto_under,
          input.daily_limit,
        ].every(Number.isSafeInteger) ||
        input.cap < 0 ||
        input.per_action < 1 ||
        input.auto_under < 0 ||
        input.auto_under > input.per_action ||
        input.per_action > input.cap ||
        input.daily_limit < 1 ||
        input.daily_limit > 100 ||
        !["draft", "ask", "auto"].includes(input.mode)
      )
        throw new MerchantError(
          "INVALID_LIMITS",
          "Use positive limits with automatic maximum no higher than per-action and wallet limits.",
        );
      const balance = this.store.publicWallet(owner, wallet);
      const timezone = input.timezone ?? wallet.timezone;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(
          this.store.now(),
        );
      } catch {
        throw new MerchantError(
          "INVALID_TIMEZONE",
          "Choose a valid timezone, such as Asia/Dubai.",
        );
      }
      const period = input.period ?? wallet.period;
      if (!["week", "month"].includes(period))
        throw new MerchantError(
          "INVALID_PERIOD",
          "Choose a weekly or monthly wallet budget.",
        );
      const expiry = input.expires_at ?? wallet.expires_at;
      if (
        !Number.isFinite(new Date(expiry).getTime()) ||
        new Date(expiry) <= this.store.now()
      )
        throw new MerchantError(
          "INVALID_EXPIRY",
          "Choose a future permission expiry.",
        );
      if (input.cap < balance.spent + balance.reserved)
        throw new MerchantError(
          "COMMITTED_FUNDS",
          "The cap cannot be below already spent or reserved funds.",
        );
      Object.assign(wallet, {
        cap: input.cap,
        per_action: input.per_action,
        auto_under: input.auto_under,
        daily_limit: input.daily_limit,
        mode: input.mode,
        paused: input.paused ?? wallet.paused,
        expires_at: new Date(expiry).toISOString(),
        revision: wallet.revision + 1,
      });
      if (period !== wallet.period || timezone !== wallet.timezone) {
        if (balance.spent + balance.reserved > 0)
          wallet.pending_reset = {
            period,
            timezone,
            wait_for_key: periodKey(wallet, this.store.now()),
          };
        else {
          wallet.period = period;
          wallet.timezone = timezone;
          delete wallet.pending_reset;
        }
      }
      this.store.saveWallet(wallet);
      this.store.log(
        owner,
        "RULES_UPDATED",
        "Service wallet limits saved by its owner.",
        wallet.service_id,
      );
      return this.store.publicWallet(owner, wallet);
    });
  }
  async approve(
    owner: string,
    id: string,
    rules?: Parameters<AppService["updateRules"]>[2],
  ) {
    let proposal = this.store.proposal(owner, id);
    let wallet = this.store.wallet(owner, proposal.wallet_id);
    if (["PAYING", "RECONCILING", "PAID"].includes(proposal.status))
      return { type: "proposal", proposal: await this.pay(owner, id) };
    if (!["NEEDS_APPROVAL", "APPROVED"].includes(proposal.status))
      throw new MerchantError(
        "PROPOSAL_CLOSED",
        "This proposal cannot be approved.",
      );
    if (rules) {
      this.updateRules(owner, wallet.id, rules);
      wallet = this.store.wallet(owner, wallet.id);
      proposal.wallet_revision = wallet.revision;
    }
    if (wallet.revision !== proposal.wallet_revision)
      throw new MerchantError(
        "RULES_CHANGED",
        "Review a fresh proposal after changing wallet rules.",
      );
    if (wallet.mode === "draft")
      throw new MerchantError(
        "DRAFT_ONLY",
        "Choose Ask every time or Automatic within limits to authorize payment.",
      );
    if (wallet.paused || wallet.status === "revoked")
      throw new MerchantError(
        "WALLET_PAUSED",
        "Resume or reconnect this service wallet first.",
      );
    if (new Date(wallet.expires_at) <= this.store.now())
      throw new MerchantError(
        "PERMISSION_EXPIRED",
        "This wallet permission expired. Save a future expiry before approving.",
      );
    if (proposal.amount > wallet.per_action)
      throw new MerchantError(
        "ACTION_LIMIT",
        "This action exceeds the saved per-action limit.",
      );
    if (
      proposal.kind !== "condition" &&
      (!proposal.quote_expires ||
        new Date(proposal.quote_expires) <= this.store.now())
    )
      throw new MerchantError(
        "QUOTE_EXPIRED",
        "This price expired. Ask for a fresh proposal.",
      );
    if (
      !configured("PAYPAL_CLIENT_ID") ||
      !configured("PAYPAL_MERCHANT_ID") ||
      !configured("AGENTMAIL_API_KEY")
    )
      throw new MerchantError(
        "SETUP_REQUIRED",
        "Add the PayPal and email credentials before approving a live sandbox action.",
      );
    wallet = await this.mail.provisionAddress(this.store, wallet);
    proposal.status = "APPROVED";
    this.store.saveProposal(proposal);
    this.store.log(
      owner,
      "OWNER_APPROVED",
      "Exact service, wallet, amount and terms approved.",
      proposal.service_id,
      proposal.amount,
    );
    if (!wallet.vault_id) {
      const state = this.store.createSetup(owner, {
        wallet_id: wallet.id,
        proposal_id: id,
        setup_id: null,
        revision: wallet.revision,
        created_at: this.store.now().toISOString(),
      });
      const origin = process.env.APP_URL ?? "http://localhost:3000";
      const setup = await this.paypal.setup(
        wallet.id,
        `${origin}/api/paypal/return?state=${encodeURIComponent(state)}`,
        `${origin}/api/paypal/cancel?state=${encodeURIComponent(state)}`,
        state,
      );
      const link = setup.links?.find((link) => link.rel === "approve")?.href;
      if (!link || !setup.id)
        throw new MerchantError(
          "PAYPAL_SETUP_INCOMPLETE",
          "PayPal did not return a wallet approval link.",
        );
      const approval = new URL(link);
      if (
        approval.protocol !== "https:" ||
        !approval.hostname.endsWith(".sandbox.paypal.com")
      )
        throw new MerchantError(
          "PAYPAL_APPROVAL_LINK",
          "PayPal returned an unexpected approval destination.",
        );
      this.store.db
        .prepare("UPDATE setup SET body=? WHERE id=? AND owner=?")
        .run(
          JSON.stringify({
            wallet_id: wallet.id,
            proposal_id: id,
            setup_id: setup.id,
            revision: wallet.revision,
            created_at: this.store.now().toISOString(),
          }),
          state,
          owner,
        );
      return { type: "redirect", url: link };
    }
    if (proposal.kind === "condition") {
      proposal.status = "WAITING";
      this.store.saveProposal(proposal);
      this.store.log(
        owner,
        "RULE_ARMED",
        proposal.rationale,
        proposal.service_id,
      );
      return { type: "proposal", proposal };
    }
    return { type: "proposal", proposal: await this.pay(owner, id) };
  }
  async finishSetup(owner: string, stateId: string) {
    const setup = this.store.setup<{
      wallet_id: string;
      proposal_id: string;
      setup_id: string | null;
      revision: number;
      created_at: string;
    }>(owner, stateId);
    if (
      !setup.setup_id ||
      this.store.now().getTime() - new Date(setup.created_at).getTime() >
        15 * 60_000
    )
      throw new MerchantError(
        "SETUP_EXPIRED",
        "This wallet connection expired. Review and connect again.",
      );
    let wallet = this.store.wallet(owner, setup.wallet_id);
    if (
      wallet.revision !== setup.revision ||
      wallet.paused ||
      wallet.status === "revoked"
    )
      throw new MerchantError(
        "RULES_CHANGED",
        "Wallet permission changed during PayPal approval.",
      );
    const token = await this.paypal.exchange(setup.setup_id, stateId);
    wallet = this.store.wallet(owner, setup.wallet_id);
    if (
      wallet.revision !== setup.revision ||
      wallet.paused ||
      wallet.status === "revoked" ||
      new Date(wallet.expires_at) <= this.store.now()
    ) {
      this.store.setSetting(`token-cleanup:${owner}:${stateId}`, {
        encrypted: encryptToken(token, this.store.vaultSecret),
      });
      try {
        await this.cleanupTokens(owner);
      } catch {
        /* The encrypted cleanup intent remains durable. */
      }
      throw new MerchantError(
        "RULES_CHANGED",
        "Wallet permission changed during PayPal approval. No payment was dispatched.",
      );
    }
    wallet.vault_id = token;
    wallet.status = "ready";
    this.store.saveWallet(wallet);
    this.store.deleteSetup(owner, stateId);
    this.store.log(
      owner,
      "PAYPAL_CONNECTED",
      "Merchant-bound token saved on the server.",
      wallet.service_id,
    );
    const proposal = this.store.proposal(owner, setup.proposal_id);
    if (proposal.kind === "condition") {
      proposal.status = "WAITING";
      this.store.saveProposal(proposal);
      return proposal;
    }
    return this.pay(owner, proposal.id);
  }
  async pay(owner: string, id: string): Promise<Proposal> {
    let proposal = this.store.proposal(owner, id);
    if (proposal.status === "PAID") return proposal;
    proposal = this.store.reserve(owner, id);
    const wallet = this.store.wallet(owner, proposal.wallet_id);
    try {
      if (!proposal.merchant_action_id) {
        const wallet = this.store.wallet(owner, proposal.wallet_id);
        if (!wallet.email)
          throw new MerchantError(
            "ADDRESS_REQUIRED",
            "Create the service address before payment.",
          );
        if (!proposal.quote_id)
          throw new MerchantError("QUOTE_REQUIRED", "Request a fresh quote.");
        const tool =
          proposal.kind === "subscribe"
            ? "subscribe"
            : proposal.kind === "book"
              ? "book"
              : "place_order";
        const action = await merchantTool<Action>(proposal.service_id, tool, {
          quote_id: proposal.quote_id,
          address: wallet.email,
          idempotency_key: proposal.id,
          ...(tool === "subscribe" ? { paid_periods: 1 } : {}),
        });
        proposal.merchant_action_id = action.id;
        this.store.saveProposal(proposal);
      }
      let order = proposal.paypal_order_id
        ? await this.paypal.getOrder(proposal.paypal_order_id)
        : await this.paypal.createOrder(
            proposal.merchant_action_id!,
            proposal.amount,
            wallet.vault_id!,
            proposal.id,
          );
      if (!order.id)
        throw new MerchantError(
          "PAYMENT_UNCERTAIN",
          "PayPal did not return an order ID.",
        );
      proposal.paypal_order_id = order.id;
      this.store.saveProposal(proposal);
      if (order.status === "APPROVED")
        order = await this.paypal.captureOrder(
          order.id,
          proposal.id.replaceAll("-", "") + "cap",
        );
      if (
        order.status === "COMPLETED" &&
        !order.purchase_units?.some((unit) => unit.payments?.captures?.length)
      )
        order = await this.paypal.getOrder(proposal.paypal_order_id!);
      const capture = order.purchase_units
        ?.flatMap((unit) => unit.payments?.captures ?? [])
        .find((capture) => capture.status === "COMPLETED");
      if (!capture)
        throw new MerchantError(
          "PAYMENT_PENDING",
          "PayPal payment is awaiting confirmation.",
        );
      if (
        capture.amount.currency_code !== "USD" ||
        capture.amount.value !== (proposal.amount / 100).toFixed(2)
      )
        throw new MerchantError(
          "CAPTURE_MISMATCH",
          "PayPal capture amount does not match this proposal.",
        );
      proposal.capture_id = capture.id;
      this.store.saveProposal(proposal);
      const response = await fetch(
        `${process.env.MOCK_MERCHANT_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`}/internal/payments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.MOCK_ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action_id: proposal.merchant_action_id,
            capture_id: capture.id,
            order_id: proposal.paypal_order_id,
          }),
          signal: AbortSignal.timeout(25_000),
        },
      );
      if (!response.ok)
        throw new MerchantError(
          "MERCHANT_CONFIRMATION_PENDING",
          "Payment completed; the service is still verifying it.",
        );
      const { action } = (await response.json()) as { action: Action };
      if (!["ACTIVE", "CONFIRMED"].includes(action.status))
        throw new MerchantError(
          "FULFILLMENT_REVIEW",
          "Payment needs service review before fulfillment.",
        );
      this.store.transaction(() => {
        const current = this.store.proposal(owner, id);
        if (current.status === "PAID") return;
        current.status = "PAID";
        current.reserved = 0;
        current.reason = null;
        current.period_end = action.period_end ?? null;
        current.cancel_effective_at = action.cancel_effective_at ?? null;
        this.store.saveProposal(current);
        const currentWallet = this.store.wallet(owner, current.wallet_id);
        if (currentWallet.status !== "revoked") currentWallet.status = "active";
        this.store.saveWallet(currentWallet);
        this.store.log(
          owner,
          "PAYMENT_COMPLETED",
          "Capture independently verified by the merchant.",
          current.service_id,
          current.amount,
        );
      });
      try {
        await this.mail.deliverOutbox(this.store);
        await this.mail.syncInbox(
          this.store,
          this.store.wallet(owner, wallet.id),
        );
      } catch {
        this.store.log(
          owner,
          "EMAIL_PENDING",
          "Payment completed; waiting for actual receipt delivery.",
          proposal.service_id,
        );
      }
    } catch (error) {
      proposal = this.store.proposal(owner, id);
      if (proposal.status === "PAID") return proposal;
      if (!proposal.merchant_action_id) {
        proposal.status = "BLOCKED";
        proposal.reserved = 0;
        proposal.reason =
          error instanceof Error
            ? error.message
            : "Service preparation failed before payment.";
        this.store.saveProposal(proposal);
        this.store.log(
          owner,
          "SERVICE_PREPARATION_FAILED",
          proposal.reason,
          proposal.service_id,
        );
        return proposal;
      }
      proposal.status = "RECONCILING";
      proposal.reason =
        error instanceof Error
          ? error.message
          : "Payment status needs reconciliation.";
      this.store.saveProposal(proposal);
      this.store.log(
        owner,
        "PAYMENT_RECONCILING",
        proposal.reason,
        proposal.service_id,
        proposal.amount,
      );
    }
    return this.store.proposal(owner, id);
  }
  decline(owner: string, id: string) {
    const p = this.store.proposal(owner, id);
    if (["PAYING", "RECONCILING", "PAID"].includes(p.status))
      throw new MerchantError(
        "ALREADY_DISPATCHED",
        "This payment has already been dispatched.",
      );
    p.status = "DECLINED";
    p.reserved = 0;
    this.store.saveProposal(p);
    this.store.log(
      owner,
      "OWNER_DECLINED",
      "Proposal declined without a charge.",
      p.service_id,
    );
    return p;
  }
  pause(owner: string, walletId: string, paused: boolean) {
    return this.store.transaction(() => {
      const wallet = this.store.wallet(owner, walletId);
      if (wallet.status === "revoked" && !paused)
        throw new MerchantError(
          "RECONNECT_REQUIRED",
          "Reconnect this service before enabling payments.",
        );
      wallet.paused = paused;
      wallet.revision++;
      this.store.saveWallet(wallet);
      for (const p of this.store
        .proposals(owner)
        .filter(
          (p) =>
            p.wallet_id === walletId &&
            ["WAITING", "APPROVED"].includes(p.status),
        )) {
        p.status = "BLOCKED";
        p.reason = "Service wallet permission changed.";
        this.store.saveProposal(p);
      }
      this.store.log(
        owner,
        paused ? "WALLET_PAUSED" : "WALLET_RESUMED",
        "New actions use the updated wallet permission.",
        wallet.service_id,
      );
      return this.store.publicWallet(owner, wallet);
    });
  }
  async cancel(owner: string, id: string) {
    const p = this.store.proposal(owner, id);
    if (p.kind !== "subscribe" || !p.merchant_action_id)
      throw new MerchantError(
        "UNSUPPORTED_OPERATION",
        "Choose an active streaming subscription.",
      );
    const action = await merchantTool<Action>(p.service_id, "cancel", {
      action_id: p.merchant_action_id,
      effective: "period_end",
      idempotency_key: `cancel-${p.id}`,
    });
    p.cancel_effective_at = action.cancel_effective_at ?? null;
    this.store.saveProposal(p);
    this.store.log(
      owner,
      "CANCELLATION_SCHEDULED",
      "Renewal disabled; cancellation effective at the paid-period end.",
      p.service_id,
    );
    await this.mail.deliverOutbox(this.store);
    return p;
  }
  async reset(owner: string) {
    const proposals = this.store.transaction(() => {
      const proposals = this.store.proposals(owner);
      if (proposals.some((p) => ["PAYING", "RECONCILING"].includes(p.status)))
        throw new MerchantError(
          "PAYMENT_PENDING",
          "Resolve the in-flight payment before resetting this demo.",
        );
      for (const wallet of this.store.wallets(owner)) {
        wallet.paused = true;
        wallet.revision++;
        this.store.saveWallet(wallet);
      }
      for (const proposal of proposals.filter((p) =>
        ["WAITING", "APPROVED", "NEEDS_APPROVAL", "DRAFT"].includes(p.status),
      )) {
        proposal.status = "BLOCKED";
        proposal.reason = "Demo workspace reset.";
        this.store.saveProposal(proposal);
      }
      return proposals;
    });
    for (const proposal of proposals.filter(
      (p) =>
        p.status === "PAID" && p.kind === "subscribe" && p.merchant_action_id,
    )) {
      const action = await merchantTool<Action>(proposal.service_id, "cancel", {
        action_id: proposal.merchant_action_id,
        effective: "immediate",
        idempotency_key: `reset-${proposal.id}`,
      });
      proposal.cancel_effective_at = action.cancel_effective_at ?? null;
      this.store.saveProposal(proposal);
    }
    this.store.log(
      owner,
      "DEMO_RESET",
      "Old service wallets paused and fixture subscriptions canceled. Captured sandbox payments remain recorded.",
    );
  }
  async evaluateConditions(owner: string) {
    for (const observed of this.store
      .proposals(owner)
      .filter((p) => p.status === "WAITING" && p.kind === "condition")) {
      const wallet = this.store.wallet(owner, observed.wallet_id);
      if (
        wallet.paused ||
        wallet.status === "revoked" ||
        new Date(wallet.expires_at) <= this.store.now() ||
        wallet.revision !== observed.wallet_revision
      ) {
        observed.status = "BLOCKED";
        observed.reason = "Wallet permission changed.";
        this.store.saveProposal(observed);
        continue;
      }
      if (
        !observed.condition_expires ||
        new Date(observed.condition_expires) <= this.store.now()
      ) {
        observed.status = "EXPIRED";
        this.store.saveProposal(observed);
        continue;
      }
      const quote = await merchantTool<Quote>(
        observed.service_id,
        "get_quote",
        { item_id: observed.item_id, quantity: observed.quantity },
      );
      if (
        observed.condition_under === null ||
        quote.amount_minor >= observed.condition_under
      )
        continue;
      const fired = this.store.transaction(() => {
        const current = this.store.proposal(owner, observed.id);
        if (current.status !== "WAITING") return null;
        current.kind = "buy";
        current.quote_id = quote.id;
        current.quote_expires = quote.expires_at;
        current.amount = quote.amount_minor;
        current.status =
          wallet.mode === "auto" && current.amount <= wallet.auto_under
            ? "APPROVED"
            : "NEEDS_APPROVAL";
        current.reason =
          "The exact item now meets the approved price condition.";
        this.store.saveProposal(current);
        this.store.log(
          owner,
          "PRICE_CONDITION_MET",
          current.reason,
          current.service_id,
          current.amount,
        );
        return current;
      });
      if (fired?.status === "APPROVED") await this.pay(owner, fired.id);
    }
  }
  async cleanupTokens(owner: string) {
    if (!configured("PAYPAL_CLIENT_ID") || !configured("PAYPAL_CLIENT_SECRET"))
      return;
    const removedTokens = new Set<string>();
    for (const row of this.store.db
      .prepare("SELECT key,body FROM settings WHERE key LIKE ?")
      .all(`token-cleanup:${owner}:%`)) {
      const record = JSON.parse(row.body as string) as {
        encrypted: string;
        wallet_id?: string;
      };
      const token = decryptToken(record.encrypted, this.store.vaultSecret);
      const references = this.store.db
        .prepare("SELECT owner,id FROM wallets")
        .all()
        .map((row) => this.store.wallet(row.owner as string, row.id as string))
        .filter((wallet) => wallet.vault_id === token);
      if (
        references.some((wallet) =>
          this.store
            .proposals(wallet.owner)
            .some(
              (p) =>
                p.wallet_id === wallet.id &&
                ["PAYING", "RECONCILING"].includes(p.status),
            ),
        )
      )
        continue;
      const usedElsewhere = references.some(
        (wallet) => wallet.status !== "revoked",
      );
      if (!usedElsewhere && !removedTokens.has(token)) {
        try {
          await this.paypal.removeToken(token);
        } catch (error) {
          if (
            !(error instanceof MerchantError) ||
            !["RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID"].includes(error.code)
          )
            throw error;
        }
        removedTokens.add(token);
      }
      if (record.wallet_id) {
        const wallet = this.store.wallet(owner, record.wallet_id);
        if (wallet.status === "revoked" && wallet.vault_id === token) {
          wallet.vault_id = null;
          this.store.saveWallet(wallet);
        }
      }
      this.store.deleteSetting(row.key as string);
    }
  }
  async revoke(owner: string, walletId: string) {
    this.store.transaction(() => {
      const wallet = this.store.wallet(owner, walletId);
      wallet.paused = true;
      wallet.status = "revoked";
      wallet.revision++;
      this.store.saveWallet(wallet);
      for (const p of this.store
        .proposals(owner)
        .filter(
          (p) =>
            p.wallet_id === walletId &&
            ["WAITING", "APPROVED", "NEEDS_APPROVAL"].includes(p.status),
        )) {
        p.status = "BLOCKED";
        p.reason = "Service payment permission revoked.";
        this.store.saveProposal(p);
      }
      if (wallet.vault_id)
        this.store.setSetting(`token-cleanup:${owner}:wallet-${walletId}`, {
          wallet_id: walletId,
          encrypted: encryptToken(wallet.vault_id, this.store.vaultSecret),
        });
      this.store.log(
        owner,
        "PAYMENT_PERMISSION_REVOKED",
        "New spending stopped. Paid access and dispatched payments are not undone.",
        wallet.service_id,
      );
    });
    try {
      await this.cleanupTokens(owner);
    } catch {
      this.store.log(
        owner,
        "TOKEN_REMOVAL_PENDING",
        "Spending is disabled. Provider token removal will retry.",
        this.store.wallet(owner, walletId).service_id,
      );
    }
    return this.store.publicWallet(owner, this.store.wallet(owner, walletId));
  }
  reconnect(owner: string, walletId: string) {
    const wallet = this.store.wallet(owner, walletId);
    if (wallet.status !== "revoked")
      return this.store.publicWallet(owner, wallet);
    if (wallet.vault_id)
      throw new MerchantError(
        "TOKEN_REMOVAL_PENDING",
        "Finish the previous disconnection before reconnecting.",
      );
    wallet.status = "draft";
    wallet.paused = false;
    wallet.mode = "draft";
    wallet.revision++;
    this.store.saveWallet(wallet);
    this.store.log(
      owner,
      "RECONNECT_REQUESTED",
      "Fresh payment permission and a PayPal connection are required.",
      wallet.service_id,
    );
    return this.store.publicWallet(owner, wallet);
  }
  async sync(owner: string) {
    await this.evaluateConditions(owner);
    for (const wallet of this.store.wallets(owner)) {
      try {
        await this.mail.syncInbox(this.store, wallet);
      } catch {
        this.store.log(
          owner,
          "INBOX_SYNC_PENDING",
          "Waiting for service email; retry is available.",
          wallet.service_id,
        );
      }
    }
    for (const p of this.store
      .proposals(owner)
      .filter((p) => ["PAYING", "RECONCILING"].includes(p.status))) {
      await this.pay(owner, p.id);
    }
    const latestSubscriptions = new Map<string, Proposal>();
    for (const p of this.store.proposals(owner)) {
      if (
        p.status === "PAID" &&
        p.kind === "subscribe" &&
        p.merchant_action_id &&
        !latestSubscriptions.has(p.wallet_id)
      )
        latestSubscriptions.set(p.wallet_id, p);
    }
    for (const p of latestSubscriptions.values()) {
      const action = await merchantTool<Action>(p.service_id, "get_status", {
        action_id: p.merchant_action_id,
      });
      if (action.status === "CANCELED") {
        const latest = this.store
          .proposals(owner)
          .find(
            (candidate) =>
              candidate.wallet_id === p.wallet_id &&
              candidate.kind === "subscribe" &&
              candidate.status === "PAID",
          );
        if (latest?.id !== p.id) continue;
        const wallet = this.store.wallet(owner, p.wallet_id);
        if (wallet.status !== "canceled" && wallet.status !== "revoked") {
          wallet.status = "canceled";
          this.store.saveWallet(wallet);
          p.cancel_effective_at =
            action.cancel_effective_at ?? p.cancel_effective_at;
          this.store.saveProposal(p);
          this.store.log(
            owner,
            "SERVICE_CANCELED",
            "Paid access ended; the original capture remains in the wallet ledger.",
            p.service_id,
          );
        }
      }
    }
    await this.cleanupTokens(owner);
    await this.mail.deliverOutbox(this.store);
    return this.state(owner);
  }
}
