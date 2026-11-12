import { createHash, randomUUID } from "node:crypto";
import { replyAddresses } from "./reply-routing.ts";
import { isSharedDemoOwner } from "./auth.ts";
import {
  MerchantError,
  isMerchantError,
  type Action,
  type Quote,
  type Service,
} from "@mailbox/service-sdk";
import { AppStore, periodKey } from "./app-store.ts";
import { configured, modelName, modelReady } from "./ai.ts";
import type {
  AppState,
  Message,
  Proposal,
  Wallet,
  PreparedReply,
} from "./app-model.ts";
import { merchantTool } from "./service-connector.ts";
import { PayPal } from "./paypal.ts";
import {
  deliverOutbox,
  provisionAddress,
  sendAgentReply,
  syncInbox,
  syncAgentInbox,
} from "./email.ts";
import { catalogue } from "./catalogue.ts";
import { encryptToken, decryptToken } from "./token-vault.ts";
import { sampleAgents, defaultAgent } from "./agents.ts";
import { runAgent } from "./agent-run.ts";
import { nextAgentTurn, type AgentTurn } from "./agent-model.ts";
import {
  cancellationReviews,
  confirmCancellationReview,
  discardCancellationReview,
  cancellationReview,
} from "./cancellation-review.ts";
import {
  makeMonthlySchedule,
  monthlyDue,
  monthlyPeriodHasPurchase,
  nextMonthlyDue,
  scheduledPurchaseId,
  validateScheduledQuote,
  assertScheduledDispatch,
  type MonthlyPurchaseInput,
} from "./purchase-schedules.ts";

/** "Daily Paws <offers@example.com>" becomes "Daily Paws". */
const senderName = (from: Message["from"]) =>
  from.replace(/\s*<[^>]*>\s*$/, "").trim() || from;

/** The next bookable slot for a service: its weekday, its first time, a table for two. */
function nextSlot(
  now: Date,
  rules: { weekday: number; times: readonly string[] },
): NonNullable<Proposal["booking"]> {
  const time = rules.times[0] ?? "19:00";
  const local = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  let delta = (rules.weekday - local.getUTCDay() + 7) % 7;
  if (delta === 0 && local.getUTCHours() >= Number(time.slice(0, 2))) delta = 7;
  local.setUTCDate(local.getUTCDate() + delta);
  return { date: local.toISOString().slice(0, 10), time, party_size: 2 };
}

export class AppService {
  constructor(
    readonly store: AppStore,
    readonly paypal = new PayPal(),
    readonly mail: {
      provisionAddress: typeof provisionAddress;
      deliverOutbox: typeof deliverOutbox;
      syncInbox: typeof syncInbox;
      syncAgentInbox?: typeof syncAgentInbox;
      sendReply?: typeof sendAgentReply;
    } = {
      provisionAddress,
      deliverOutbox,
      syncInbox,
      syncAgentInbox,
      sendReply: sendAgentReply,
    },
    readonly turn: AgentTurn = nextAgentTurn,
  ) {}
  state(owner: string): AppState {
    if (
      !this.store.agents(owner).length &&
      this.store
        .messages(owner)
        .some((message) => message.origin === "fixture_preview")
    ) {
      sampleAgents(this.store, owner);
      for (const message of this.store.messages(owner)) {
        const service = catalogue.services.find(
          (service) => service.id === message.service_id,
        );
        if (service && !message.agent_id) {
          message.agent_id = defaultAgent(this.store, owner, service).id;
          this.store.saveMessage(message);
        }
      }
    }
    const proposals = this.store.proposals(owner);
    return {
      now: this.store.now().toISOString(),
      agent_allowances: this.store.agents(owner).flatMap((a) => {
        const rule = this.store.agentAllowance(owner, a.id);
        return rule ? [rule] : [];
      }),
      cancellation_reviews: cancellationReviews(this.store, owner).map(
        ({ owner: _owner, ...r }) => r,
      ),
      reply_drafts: this.store.agents(owner).flatMap((a) => {
        const draft = this.store.setting<PreparedReply>(
          `agent-reply:${owner}:${a.id}`,
        );
        return draft ? [{ agent_id: a.id, draft }] : [];
      }),
      tasks: this.store.tasks(owner),
      documents: this.store
        .documents(owner)
        .map(({ text: _text, ...doc }) => doc),
      shared_demo: isSharedDemoOwner(owner),
      agents: this.store
        .agents(owner)
        .map((agent) => this.store.publicAgent(agent)),
      wallets: this.store
        .wallets(owner)
        .map((w) => this.store.publicWallet(owner, w)),
      proposals: proposals.map((p) => {
        if (p.kind !== "schedule" || !p.monthly_schedule) return p;
        const latest = proposals.find(
          (c) => c.scheduled_by?.proposal_id === p.id,
        );
        const due = monthlyDue(p.monthly_schedule, this.store.now());
        const attempted =
          monthlyPeriodHasPurchase(this.store, owner, p, this.store.now()) ||
          proposals.some(
            (c) =>
              c.scheduled_by?.proposal_id === p.id &&
              c.scheduled_by.period === due.period &&
              c.status === "DECLINED",
          );
        return {
          ...p,
          next_scheduled_at: ["DECLINED", "EXPIRED"].includes(p.status)
            ? null
            : nextMonthlyDue(p.monthly_schedule, this.store.now(), attempted),
          ...(latest
            ? {
                latest_scheduled_purchase: {
                  id: latest.id,
                  status: latest.status,
                  amount: latest.amount,
                  period: latest.scheduled_by!.period,
                  capture_id: latest.capture_id,
                },
              }
            : {}),
        };
      }),
      messages: this.store.messages(owner),
      dismissed: this.dismissed(owner),
      audit: this.store.audit(owner),
      configuration: {
        paypal:
          configured("PAYPAL_CLIENT_ID") &&
          configured("PAYPAL_CLIENT_SECRET") &&
          configured("PAYPAL_MERCHANT_ID"),
        email: configured("AGENTMAIL_API_KEY"),
        email_preview: process.env.MAILBOX_MAIL_PREVIEW === "1",
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
  private async service(id: string) {
    const service = (await this.services()).find((s) => s.id === id);
    if (!service)
      throw new MerchantError(
        "UNSUPPORTED_SERVICE",
        "Choose one of the connected fixture services.",
      );
    return service;
  }
  async ask(owner: string, text: string, agentId?: string) {
    if (text.length < 1 || text.length > 1500)
      throw new MerchantError(
        "INVALID_ASK",
        "Enter a request up to 1,500 characters.",
      );
    // Suggestions are ordinary requests. Only the model composes capabilities.
    if (agentId)
      this.store.transaction(() => {
        this.store.agent(owner, agentId);
        for (const p of this.store.proposals(owner)) {
          if (
            (p.agent_id ?? this.store.wallet(owner, p.wallet_id).agent_id) !==
              agentId ||
            !["NEEDS_APPROVAL", "APPROVED"].includes(p.status) ||
            ["condition", "schedule"].includes(p.kind) ||
            p.reserved ||
            p.dispatched_at ||
            p.merchant_action_id ||
            p.paypal_order_id ||
            p.capture_id
          )
            continue;
          if (
            !p.quote_expires ||
            !(new Date(p.quote_expires) > this.store.now())
          ) {
            p.status = "EXPIRED";
            p.reason = "The quote expired before payment. Get a fresh review.";
            this.store.saveProposal(p);
            this.store.log(
              owner,
              "QUOTE_EXPIRED",
              p.reason,
              p.service_id,
              null,
              agentId,
            );
          }
        }
      });
    if (agentId && this.mail.syncAgentInbox) {
      const agent = this.store.agent(owner, agentId);
      if (agent.inbox_id) {
        try {
          await this.mail.syncAgentInbox(this.store, agent);
        } catch {
          this.store.log(
            owner,
            "INBOX_SYNC_FAILED",
            "Could not refresh this agent's inbox. Stored evidence remains available; unverified reply routing cannot be sent.",
            null,
            null,
            agent.id,
          );
        }
      }
    }
    return runAgent({
      owner,
      text,
      store: this.store,
      turn: this.turn,
      ...(agentId ? { agentId } : {}),
      services: () => this.services(),
      propose: (serviceId, kind, options) =>
        this.propose(owner, serviceId, kind, options),
    });
  }
  async propose(
    owner: string,
    serviceId: string,
    requested: "subscribe" | "buy" | "book" | "condition" | "schedule",
    options: {
      title?: string;
      quantity?: number;
      booking?: Proposal["booking"];
      under?: number;
      item_id?: string;
      quote?: Quote;
      comparison?: Proposal["comparison"];
      sources?: string[];
      rationale?: string;
      agent_id?: string;
      monthly_schedule?: MonthlyPurchaseInput;
      owner_request?: string;
    } = {},
  ): Promise<Proposal> {
    const service = await this.service(serviceId);
    const item = options.item_id
      ? service.items.find((item) => item.id === options.item_id)
      : service.items[0];
    if (!item)
      throw new MerchantError(
        "ITEM_NOT_FOUND",
        "Choose a supported item or plan.",
      );
    const kind =
      requested === "condition" || requested === "schedule"
        ? requested
        : service.kind === "subscription"
          ? "subscribe"
          : service.kind === "booking"
            ? "book"
            : "buy";
    if (options.agent_id) this.store.agent(owner, options.agent_id);
    let wallet = this.store.ensureWallet(owner, service, options.agent_id);
    if (options.agent_id)
      wallet = this.store.attachWalletAgent(owner, wallet.id, options.agent_id);
    const quote =
      options.quote ??
      (await merchantTool<Quote>(serviceId, "get_quote", {
        item_id: item.id,
        quantity: options.quantity ?? 1,
        ...(options.booking ? { booking: options.booking } : {}),
      }));
    const now = this.store.now().toISOString();
    const monthly =
      kind === "schedule" && options.monthly_schedule
        ? makeMonthlySchedule(quote, options.monthly_schedule, this.store.now())
        : undefined;
    if (kind === "schedule" && !monthly)
      throw new MerchantError(
        "SCHEDULE_REQUIRED",
        "Choose the exact monthly purchase rule for owner review.",
      );
    const proposal: Proposal = {
      ...(options.owner_request
        ? { owner_request: options.owner_request }
        : {}),
      id: randomUUID(),
      owner,
      ...(wallet.agent_id ? { agent_id: wallet.agent_id } : {}),
      service_id: serviceId,
      wallet_id: wallet.id,
      kind,
      ...(monthly ? { monthly_schedule: monthly } : {}),
      title:
        options.title ??
        (kind === "schedule"
          ? `Monthly ${quote.item_name}`
          : kind === "subscribe"
            ? `One month of ${service.name}`
            : kind === "book"
              ? `Reserve ${quote.item_name}`
              : kind === "condition"
                ? `Buy ${quote.item_name} when its price drops`
                : quote.item_name),
      rationale:
        kind === "condition"
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
      sources: [],
      created_at: now,
      updated_at: now,
    };
    if (options.rationale) proposal.rationale = options.rationale;
    if (monthly)
      validateScheduledQuote(proposal, quote, service, this.store.now(), false);
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
      if (proposal.kind === "schedule") this.store.saveProposal(proposal);
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
    if (proposal.kind === "schedule") {
      proposal = await this.reviewSchedule(owner, id);
      wallet = this.store.wallet(owner, proposal.wallet_id);
    }
    if (proposal.kind !== "schedule" && proposal.amount > wallet.per_action)
      throw new MerchantError(
        "ACTION_LIMIT",
        "This action exceeds the saved per-action limit.",
      );
    if (proposal.kind !== "condition" && proposal.kind !== "schedule")
      this.store.assertAgentAllowance(
        owner,
        proposal.agent_id ?? wallet.agent_id,
        proposal.amount,
      );
    if (
      proposal.kind !== "condition" &&
      proposal.kind !== "schedule" &&
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
    if (proposal.kind === "schedule")
      return {
        type: "proposal",
        proposal: this.armSchedule(owner, proposal.id),
      };
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
    if (proposal.kind === "schedule") {
      await this.reviewSchedule(owner, proposal.id);
      return this.armSchedule(owner, proposal.id);
    }
    if (proposal.kind === "condition") {
      proposal.status = "WAITING";
      this.store.saveProposal(proposal);
      return proposal;
    }
    return this.pay(owner, proposal.id);
  }
  private async reviewSchedule(owner: string, id: string) {
    const p = this.store.proposal(owner, id),
      rule = p.monthly_schedule;
    const wallet = this.store.wallet(owner, p.wallet_id);
    if (
      p.kind !== "schedule" ||
      !rule ||
      !p.agent_id ||
      wallet.agent_id !== p.agent_id
    )
      throw new MerchantError(
        "SCHEDULE_REQUIRED",
        "Review the exact agent, product and monthly rule first.",
      );
    if (wallet.mode !== "auto")
      throw new MerchantError(
        "SCHEDULE_AUTO_REQUIRED",
        "Monthly purchases require an explicit automatic payment permission within your limits.",
      );
    const agent = this.store.agent(owner, p.agent_id);
    if (agent.status === "paused")
      throw new MerchantError(
        "AGENT_PAUSED",
        "Resume this agent before approving a monthly rule.",
      );
    const period = monthlyDue(rule, this.store.now()).period;
    const attempted =
      monthlyPeriodHasPurchase(this.store, owner, p, this.store.now()) ||
      this.store
        .proposals(owner)
        .some(
          (c) =>
            c.scheduled_by?.proposal_id === p.id &&
            c.scheduled_by.period === period &&
            ["PAID", "PAYING", "RECONCILING", "DECLINED"].includes(c.status),
        );
    const next = nextMonthlyDue(rule, this.store.now(), attempted);
    if (!next || new Date(wallet.expires_at) <= new Date(next))
      throw new MerchantError(
        "SCHEDULE_PERMISSION_EXPIRES",
        "The rule or wallet permission expires before the next monthly purchase. Review their expiry dates.",
      );
    const service = (await this.services()).find((s) => s.id === p.service_id);
    if (!service)
      throw new MerchantError(
        "SCHEDULE_ITEM_UNAVAILABLE",
        "The connected product service is unavailable.",
      );
    const quote = await merchantTool<Quote>(p.service_id, "get_quote", {
      item_id: p.item_id,
      quantity: p.quantity,
    });
    validateScheduledQuote(p, quote, service, this.store.now(), false);
    if (wallet.auto_under < 1 || wallet.per_action < 1)
      throw new MerchantError(
        "SCHEDULE_AUTO_LIMIT",
        "Choose a positive automatic and per-action limit for future monthly purchases.",
      );
    const current = this.store.proposal(owner, id);
    if (
      !["NEEDS_APPROVAL", "APPROVED"].includes(current.status) ||
      current.wallet_revision !==
        this.store.wallet(owner, current.wallet_id).revision
    )
      throw new MerchantError(
        "RULES_CHANGED",
        "The monthly rule or wallet changed while its current quote was being checked.",
      );
    current.quote_id = quote.id;
    current.quote_expires = quote.expires_at;
    current.amount = quote.amount_minor;
    this.store.saveProposal(current);
    return current;
  }
  private armSchedule(owner: string, id: string) {
    return this.store.transaction(() => {
      const p = this.store.proposal(owner, id),
        wallet = this.store.wallet(owner, p.wallet_id),
        rule = p.monthly_schedule;
      if (
        p.kind !== "schedule" ||
        p.status !== "APPROVED" ||
        !rule ||
        !wallet.vault_id ||
        wallet.mode !== "auto" ||
        wallet.paused ||
        wallet.status === "revoked" ||
        wallet.revision !== p.wallet_revision ||
        new Date(rule.expires_at) <= this.store.now() ||
        new Date(wallet.expires_at) <= this.store.now()
      )
        throw new MerchantError(
          "SCHEDULE_APPROVAL_REQUIRED",
          "The monthly rule needs current owner approval and a valid saved payment permission.",
        );
      if (
        this.store
          .proposals(owner)
          .some(
            (o) =>
              o.id !== p.id &&
              o.kind === "schedule" &&
              o.status === "WAITING" &&
              o.agent_id === p.agent_id &&
              o.service_id === p.service_id &&
              o.item_id === p.item_id,
          )
      )
        throw new MerchantError(
          "SCHEDULE_EXISTS",
          "An approved monthly rule already covers this exact product. Stop it before approving a replacement.",
        );
      rule.approved_at = this.store.now().toISOString();
      p.status = "WAITING";
      p.reason = null;
      this.store.saveProposal(p);
      this.store.log(
        owner,
        "MONTHLY_RULE_APPROVED",
        "Owner approved one exact-item purchase per eligible calendar month within the saved boundaries. No purchase was dispatched by this approval.",
        p.service_id,
        null,
        p.agent_id,
      );
      return p;
    });
  }
  /** Generic standing-rule execution. No product names or scenario-specific decisions. */
  async evaluateSchedules(owner: string) {
    for (const observed of this.store
      .proposals(owner)
      .filter((p) => p.kind === "schedule" && p.status === "WAITING")) {
      const rule = observed.monthly_schedule;
      if (!rule) continue;
      if (new Date(rule.expires_at) <= this.store.now()) {
        observed.status = "EXPIRED";
        observed.reason = "The approved monthly rule expired.";
        this.store.saveProposal(observed);
        continue;
      }
      const due = monthlyDue(rule, this.store.now());
      if (!due.eligible) continue;
      const children = this.store
        .proposals(owner)
        .filter((p) => p.scheduled_by?.proposal_id === observed.id);
      const pending = children.find((p) =>
        ["PAYING", "RECONCILING"].includes(p.status),
      );
      if (pending) {
        await this.pay(owner, pending.id);
        continue;
      }
      const existing = children.find(
        (p) => p.scheduled_by!.period === due.period,
      );
      if (
        monthlyPeriodHasPurchase(
          this.store,
          owner,
          observed,
          this.store.now(),
        ) &&
        !existing
      )
        continue;
      if (
        existing &&
        (existing.status === "PAID" ||
          existing.status === "DECLINED" ||
          existing.merchant_action_id ||
          existing.paypal_order_id ||
          existing.capture_id ||
          existing.reserved)
      )
        continue;
      try {
        const service = (await this.services()).find(
          (s) => s.id === observed.service_id,
        );
        if (!service)
          throw new MerchantError(
            "SCHEDULE_ITEM_UNAVAILABLE",
            "The exact product service is unavailable. Review is required.",
          );
        const quote = await merchantTool<Quote>(
          observed.service_id,
          "get_quote",
          { item_id: observed.item_id, quantity: observed.quantity },
        );
        validateScheduledQuote(observed, quote, service, this.store.now());
        const child = this.store.transaction(() => {
          const parent = this.store.proposal(owner, observed.id);
          if (parent.status !== "WAITING") return null;
          const prior = this.store
            .proposals(owner)
            .find(
              (p) =>
                p.scheduled_by?.proposal_id === parent.id &&
                p.scheduled_by.period === due.period,
            );
          if (
            prior &&
            ["PAID", "PAYING", "RECONCILING", "DECLINED"].includes(prior.status)
          )
            return null;
          if (
            prior &&
            (prior.merchant_action_id ||
              prior.paypal_order_id ||
              prior.capture_id ||
              prior.reserved)
          )
            return null;
          const {
            monthly_schedule: _schedule,
            comparison: _comparison,
            ...base
          } = parent;
          const p: Proposal = {
            ...base,
            id: scheduledPurchaseId(parent.id, due.period),
            kind: "buy",
            status: "APPROVED",
            title: quote.item_name,
            scheduled_by: { proposal_id: parent.id, period: due.period },
            rationale: `Monthly purchase under the owner's exact-item standing rule for ${due.period}.`,
            amount: quote.amount_minor,
            quote_id: quote.id,
            quote_expires: quote.expires_at,
            reserved: 0,
            period_key: null,
            merchant_action_id: null,
            paypal_order_id: null,
            capture_id: null,
            reason: null,
            created_at: prior?.created_at ?? this.store.now().toISOString(),
            updated_at: this.store.now().toISOString(),
          };
          assertScheduledDispatch(this.store, owner, p);
          this.store.saveProposal(p);
          return p;
        });
        if (child) {
          const outcome = await this.pay(owner, child.id);
          if (!["PAID", "PAYING", "RECONCILING"].includes(outcome.status))
            throw new MerchantError(
              "SCHEDULE_PURCHASE_REVIEW",
              outcome.reason ??
                "The monthly order needs review before another attempt.",
            );
        }
      } catch (error) {
        const p = this.store.proposal(owner, observed.id);
        if (p.status !== "WAITING") continue;
        p.status = "NEEDS_APPROVAL";
        p.monthly_schedule!.approved_at = null;
        p.reason =
          error instanceof Error
            ? error.message
            : "The monthly purchase needs owner review. No new order was dispatched.";
        this.store.saveProposal(p);
        this.store.log(
          owner,
          "MONTHLY_RULE_REVIEW_REQUIRED",
          p.reason,
          p.service_id,
          null,
          p.agent_id,
        );
      }
    }
  }
  async pay(owner: string, id: string): Promise<Proposal> {
    let proposal = this.store.proposal(owner, id);
    if (proposal.status === "PAID") return proposal;
    if (proposal.history_source)
      throw new MerchantError(
        "LINKED_HISTORY_READONLY",
        "This historical payment is read-only. Manage its original service connection.",
      );
    try {
      proposal = this.store.reserve(owner, id);
    } catch (error) {
      // A policy rejection before dispatch must return to the owner's review
      // queue. Never rewrite an action whose payment outcome may be uncertain.
      const current = this.store.proposal(owner, id);
      if (
        current.status === "APPROVED" &&
        current.kind !== "condition" &&
        current.reserved === 0 &&
        !current.merchant_action_id &&
        !current.paypal_order_id &&
        !current.capture_id
      ) {
        current.status = current.scheduled_by ? "BLOCKED" : "NEEDS_APPROVAL";
        if (current.scheduled_by)
          current.reason =
            error instanceof Error
              ? error.message
              : "The monthly rule needs owner review before dispatch.";
        this.store.saveProposal(current);
      }
      throw error;
    }
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
  /** Sends a reply the owner approved, from the agent's own address, once per request. */
  async sendReply(
    owner: string,
    messageId: string,
    text: string,
    requestId: string,
    documentIds: string[] = [],
    draftId?: string,
  ) {
    const message = this.store
      .messages(owner)
      .find((candidate) => candidate.id === messageId);
    if (!message)
      throw new MerchantError("NOT_FOUND", "That message is no longer here.");
    const body = text.trim();
    if (!body || body.length > 4000)
      throw new MerchantError(
        "INVALID_REPLY",
        "Write a reply of up to 4,000 characters.",
      );
    if (message.facts.suspicious)
      throw new MerchantError(
        "NOT_REPLIABLE",
        "This message was blocked, so the agent will not reply to it.",
      );
    if (!message.agent_id)
      throw new MerchantError(
        "NOT_REPLIABLE",
        "This message does not belong to an agent that can reply.",
      );
    const agent = this.store.agent(owner, message.agent_id);
    const to = senderName(message.from);
    const operationId = draftId ?? requestId;
    const key = `reply-sent:${owner}:${operationId}`;
    if (!agent.inbox_id)
      throw new MerchantError(
        "ADDRESS_REQUIRED",
        `Create ${agent.name}’s address before it can reply.`,
      );
    if (message.origin !== "agentmail" || !message.provider_id)
      throw new MerchantError(
        "NOT_REPLIABLE",
        "This is a sample preview that was never delivered, so there is no sender to reply to.",
      );
    const addresses = replyAddresses(message);
    if (message.reply_to === undefined || !addresses.length)
      throw new MerchantError(
        "REPLY_ROUTING_REQUIRED",
        "Refresh this agent's inbox to verify the reply recipient before sending.",
      );
    if (!this.mail.sendReply)
      throw new MerchantError(
        "EMAIL_NOT_CONFIGURED",
        "Replies are not available in this setup.",
      );
    const documents = [...new Set(documentIds)].map((id) =>
      this.store.document(owner, id, agent.id),
    );
    if (
      documents.length > 8 ||
      documents.some((d) => d.status !== "readable") ||
      documents.reduce((sum, d) => sum + d.size, 0) > 3 * 1024 * 1024
    )
      throw new MerchantError(
        "ATTACHMENT_LIMIT",
        "Choose up to eight readable documents totalling no more than 3 MB.",
      );
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          agent_id: agent.id,
          inbox: agent.inbox_id,
          message_id: message.id,
          provider_id: message.provider_id,
          recipients: addresses,
          body,
          documents: documents.map((d) => d.id),
        }),
      )
      .digest("hex");
    const earlier = this.store.setting<{
      fingerprint?: string;
      sent_at?: string;
      provider_message_id?: string;
    }>(key);
    if (earlier && earlier.fingerprint !== fingerprint)
      throw new MerchantError(
        "REPLY_CHANGED",
        "This approval was already used for different content, recipients or attachments. Check the original send before approving a new draft.",
      );
    if (earlier?.sent_at)
      return {
        sent: true,
        to_name: to,
        to_addresses: addresses,
        sent_at: earlier.sent_at,
        provider_message_id: earlier.provider_message_id,
      };
    const prepared = this.store.setting<PreparedReply>(
      `agent-reply:${owner}:${agent.id}`,
    );
    if (
      draftId &&
      (prepared?.id !== draftId ||
        prepared.message_id !== message.id ||
        prepared.to_address !== addresses.join(", "))
    )
      throw new MerchantError(
        "DRAFT_CHANGED",
        "This draft changed. Review the current draft before sending.",
      );
    this.store.transaction(() => {
      const current = this.store.setting<{ fingerprint?: string }>(key);
      if (current && current.fingerprint !== fingerprint)
        throw new MerchantError(
          "REPLY_CHANGED",
          "This approval is already attached to another reply.",
        );
      if (!current) this.store.setSetting(key, { fingerprint });
      if (draftId && prepared)
        this.store.setSetting(`agent-reply:${owner}:${agent.id}`, {
          ...prepared,
          body,
          documents: documents.map((d) => ({ id: d.id, filename: d.filename })),
        });
    });
    const providerMessageId = await this.mail.sendReply(
      agent,
      message,
      body,
      operationId,
      documents.map((d) => ({
        filename: d.filename,
        contentType: d.content_type,
        content: this.store.documentContent(owner, d.id).toString("base64"),
      })),
    );
    const saved = this.store.setting<PreparedReply>(
      `agent-reply:${owner}:${agent.id}`,
    );
    if (saved?.message_id === message.id && (!draftId || saved.id === draftId))
      this.store.setSetting(`agent-reply:${owner}:${agent.id}`, null);
    const sent_at = this.store.now().toISOString();
    this.store.setSetting(key, {
      fingerprint,
      sent_at,
      provider_message_id: providerMessageId,
    });
    this.store.log(
      owner,
      "REPLY_SENT",
      `To ${addresses.join(", ")}. Message ${providerMessageId}. ${documents.length} original attachments. Approved by the owner.`,
      message.service_id,
      null,
      agent.id,
    );
    return {
      sent: true,
      to_name: to,
      to_addresses: addresses,
      provider_message_id: providerMessageId,
      sent_at,
    };
  }
  dismissed(owner: string): string[] {
    return this.store.setting<string[]>(`dismissed:${owner}`) ?? [];
  }
  /** Clears a message from the owner's queue. It changes no permission and pays nothing. */
  dismissMessage(owner: string, messageId: string) {
    const message = this.store
      .messages(owner)
      .find((candidate) => candidate.id === messageId);
    if (!message)
      throw new MerchantError("NOT_FOUND", "That message is no longer here.");
    const dismissed = this.dismissed(owner);
    if (!dismissed.includes(messageId)) {
      this.store.setSetting(`dismissed:${owner}`, [...dismissed, messageId]);
      this.store.log(
        owner,
        "MESSAGE_DISMISSED",
        `"${message.subject}" was dismissed by the owner. No payment was authorized.`,
        message.service_id,
      );
    }
    return { dismissed: messageId };
  }
  /**
   * Prepares a proposal for an invoice message. The invoice is untrusted mail:
   * the amount paid is the service's own current quote, and the proposal is
   * only created when that quote equals the invoice amount.
   */
  async payInvoice(owner: string, messageId: string): Promise<Proposal> {
    const message = this.store
      .messages(owner)
      .find((candidate) => candidate.id === messageId);
    if (!message)
      throw new MerchantError("NOT_FOUND", "That message is no longer here.");
    if (
      message.kind !== "invoice" ||
      message.facts.suspicious ||
      !message.facts.amount_minor
    )
      throw new MerchantError(
        "NOT_PAYABLE",
        "This message is not an invoice with an amount that can be paid.",
      );
    const open = this.store
      .proposals(owner)
      .find(
        (proposal) =>
          proposal.sources.includes(messageId) &&
          !["DECLINED", "BLOCKED", "EXPIRED"].includes(proposal.status),
      );
    if (open) return open;
    const service = await this.service(message.service_id);
    const amount = message.facts.amount_minor;
    const item = service.items.find((item) => item.amount_minor === amount);
    const mismatch = new MerchantError(
      "INVOICE_MISMATCH",
      `${service.name} does not currently quote $${(amount / 100).toFixed(2)} for anything. Nothing was prepared.`,
    );
    if (!item) throw mismatch;
    const booking =
      service.kind === "booking" && service.booking
        ? nextSlot(this.store.now(), service.booking)
        : undefined;
    const quote = await merchantTool<Quote>(service.id, "get_quote", {
      item_id: item.id,
      quantity: 1,
      ...(booking ? { booking } : {}),
    });
    if (quote.amount_minor !== amount) throw mismatch;
    const proposal = await this.propose(
      owner,
      service.id,
      service.kind === "subscription"
        ? "subscribe"
        : service.kind === "booking"
          ? "book"
          : "buy",
      {
        item_id: item.id,
        quote,
        sources: [messageId],
        rationale: booking
          ? `${message.subject}. The amount matches the service’s current quote. The invoice does not state the reservation, so this holds ${booking.time} on ${booking.date} for ${booking.party_size}.`
          : `${message.subject}. The amount matches the service’s current quote.`,
        ...(booking ? { booking } : {}),
        ...(message.agent_id ? { agent_id: message.agent_id } : {}),
      },
    );
    proposal.title = `Pay ${message.facts.item ?? quote.item_name}`;
    this.store.saveProposal(proposal);
    return proposal;
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
    if (p.history_source)
      throw new MerchantError(
        "LINKED_HISTORY_READONLY",
        "This historical payment is read-only. Manage its original service connection.",
      );
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
  async confirmCancellations(owner: string, id: string, revision: number) {
    const review = await confirmCancellationReview(
      this.store,
      owner,
      id,
      revision,
    );
    try {
      await this.mail.deliverOutbox(this.store);
      review.delivery_pending = false;
    } catch {
      review.delivery_pending = true;
    }
    this.store.setSetting(`cancellation-review:${owner}:${id}`, review);
    const { owner: _owner, ...visible } = review;
    return { cancellation: visible };
  }
  discardCancellations(owner: string, id: string) {
    discardCancellationReview(this.store, owner, id);
    return { discarded: true };
  }
  cancellation(owner: string, id: string) {
    const { owner: _owner, ...visible } = cancellationReview(
      this.store,
      owner,
      id,
    );
    return visible;
  }
  async reset(owner: string) {
    const proposals = this.store.transaction(() => {
      const proposals = this.store.proposals(owner);
      if (proposals.some((p) => ["PAYING", "RECONCILING"].includes(p.status)))
        throw new MerchantError(
          "PAYMENT_PENDING",
          "Resolve the in-flight payment before resetting this workspace.",
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
        proposal.reason = "Workspace reset.";
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
            !isMerchantError(error) ||
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
    if (wallet.agent_id && this.store.agent(owner, wallet.agent_id).archived_at)
      throw new MerchantError(
        "AGENT_ARCHIVED",
        "This agent is archived. Connect the service from your current agent instead.",
      );
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
    await this.evaluateSchedules(owner);
    await this.evaluateConditions(owner);
    const seenInboxes = new Set<string>();
    for (const agent of this.store.agents(owner)) {
      if (agent.archived_at) continue;
      if (!agent.inbox_id || !this.mail.syncAgentInbox) continue;
      seenInboxes.add(agent.inbox_id);
      try {
        await this.mail.syncAgentInbox(this.store, agent);
      } catch {
        this.store.log(
          owner,
          "INBOX_SYNC_PENDING",
          "Waiting for agent email; retry is available.",
        );
      }
    }
    for (const wallet of this.store.wallets(owner)) {
      if (
        wallet.agent_id &&
        this.store.agent(owner, wallet.agent_id).archived_at
      )
        continue;
      if (wallet.inbox_id && seenInboxes.has(wallet.inbox_id)) continue;
      if (wallet.inbox_id) seenInboxes.add(wallet.inbox_id);
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
      const action = await merchantTool<Action>(
        p.service_id,
        "get_status",
        {
          action_id: p.merchant_action_id,
        },
        p.history_source?.base_url,
      );
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
