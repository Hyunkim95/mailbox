import { randomUUID } from "node:crypto";
import { replyAddresses } from "./reply-routing.ts";
import { MerchantError, type Quote, type Service } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Proposal, CancellationReview } from "./app-model.ts";
import { merchantTool } from "./service-connector.ts";
import { searchMarket } from "./market.ts";
import { agentTools, type AgentExchange } from "./agent-tools.ts";
import { nextAgentTurn, type AgentTurn } from "./agent-model.ts";
import { managedServices, managedServiceStatus } from "./managed-services.ts";
import { checkConfirmation } from "./receipt-matching.ts";
import { prepareCancellationReview } from "./cancellation-review.ts";
import { compareQuotes } from "./quote-comparison.ts";
import {
  nextMonthlyDue,
  monthlyPeriodHasPurchase,
  type MonthlyPurchaseInput,
} from "./purchase-schedules.ts";

type Preparation = {
  title: string;
  quantity: number;
  item_id: string;
  quote: Quote;
  booking: Proposal["booking"];
  sources: string[];
  rationale: string;
  owner_request?: string;
  comparison?: Proposal["comparison"];
  monthly_schedule?: MonthlyPurchaseInput;
  agent_id?: string;
  under?: number;
};
type Review =
  | { type: "proposal"; proposal: Proposal }
  | { type: "cancellation"; cancellation: Omit<CancellationReview, "owner"> }
  | {
      type: "reply";
      draft: {
        id: string;
        message_id: string;
        service_id: string;
        to_name: string;
        to_address: string;
        subject: string;
        body: string;
        sources: string[];
        documents: { id: string; filename: string }[];
      };
    };

type SavedTask = {
  id: string;
  text: string;
  status: "todo" | "blocked" | "ready";
  sources: string[];
  note: string;
  updated_at: string;
};

/** The model picks each capability. Code validates data access and action boundaries. */
export async function runAgent(input: {
  owner: string;
  agentId?: string;
  text: string;
  store: AppStore;
  turn?: AgentTurn;
  services: () => Promise<Service[]>;
  propose: (
    serviceId: string,
    kind: "subscribe" | "buy" | "book" | "condition" | "schedule",
    options: Preparation,
  ) => Promise<Proposal>;
  quote?: typeof merchantTool<Quote>;
  maxSteps?: number;
}) {
  const { store, owner } = input;
  if (!input.agentId)
    throw new MerchantError(
      "AGENT_REQUIRED",
      "Choose an agent before asking it to work with an inbox.",
    );
  const agent = input.agentId
    ? store.publicAgent(store.agent(owner, input.agentId))
    : null;
  if (agent?.archived_at)
    throw new MerchantError(
      "AGENT_ARCHIVED",
      "This agent is archived. Its original messages and payments remain available as history.",
    );
  const messages = store
    .messages(owner)
    .filter((m) => !agent || m.agent_id === agent.id)
    .filter((m) => !m.facts.suspicious);
  const read = new Set<string>();
  const discovered = new Map<string, Service>();
  const quotes = new Map<string, Quote>();
  let compared:
    | { quoteIds: string[]; comparison: NonNullable<Proposal["comparison"]> }
    | undefined;
  const history: AgentExchange[] = [];
  const runId = randomUUID();
  const activity: Record<string, string> = {
    search_messages: "Searched messages",
    read_message: "Read a source email",
    read_tasks: "Reviewed saved tasks",
    record_task: "Updated the checklist",
    search_documents: "Searched supporting documents",
    read_document: "Read a supporting document",
    list_services: "Checked available services",
    list_managed_services: "Checked existing services and budgets",
    get_service_status: "Verified current service status",
    match_confirmation: "Checked confirmation against payment records",
    prepare_cancellations: "Prepared a cancellation review",
    get_quote: "Checked a current quote",
    compare_quotes: "Compared current all-in unit prices",
    prepare_proposal: "Prepared a proposal for review",
    list_purchase_rules: "Reviewed saved purchase rules",
    prepare_purchase_schedule: "Prepared a monthly purchase rule for review",
    prepare_reply: "Prepared a reply for review",
    search_market: "Searched retail offers",
  };
  let review: Review | undefined;
  let market: Awaited<ReturnType<typeof searchMarket>> | undefined;
  const context = {
    request: input.text,
    agent,
    now: store.now().toISOString(),
    timezone: "Asia/Dubai",
    allowance: store.agentAllowance(owner, agent!.id),
    wallets: store
      .wallets(owner)
      .filter((w) => !agent || w.agent_id === agent.id)
      .map((w) => store.publicWallet(owner, w)),
    limitations: [
      "Only this agent's stored emails are accessible; no personal Gmail history.",
      "Text PDFs and text documents can be read. Scans, images and unsupported file types remain unread.",
      "No email sending, payment, cancellation or permission tools.",
    ],
  };
  const taskKey = `agent-tasks:${owner}:${agent?.id ?? "workspace"}`;
  function source(id: string) {
    const m = messages.find((message) => message.id === id);
    if (!m)
      throw new MerchantError(
        "SOURCE_UNAVAILABLE",
        "That source is unavailable in this agent's inbox.",
      );
    return m;
  }
  function sources(ids: string[]) {
    for (const id of ids)
      if (!read.has(id))
        throw new MerchantError(
          "SOURCE_UNREAD",
          "Read each cited source first.",
        );
    return [...new Set(ids)];
  }
  const turn = input.turn ?? nextAgentTurn;
  for (let step = 0; step < (input.maxSteps ?? 32); step++) {
    const call = await turn(
      { ...context, remaining_steps: (input.maxSteps ?? 32) - step },
      history,
    );
    let result: unknown;
    try {
      if (!Object.hasOwn(agentTools, call.name))
        throw new MerchantError(
          "TOOL_UNAVAILABLE",
          "That capability is unavailable. Use a listed tool.",
        );
      const name = call.name as keyof typeof agentTools;
      // Parsing here remains mandatory even with provider-side strict schemas.
      const args = agentTools[name].input.parse(call.arguments);
      if (name === "finish" && "answer" in args) {
        const ids = sources(args.sources);
        store.log(
          owner,
          "AGENT_FINISHED",
          `Finished after ${step} steps.`,
          null,
          null,
          agent?.id,
          runId,
        );
        return {
          ...(review ?? market ?? { type: "answer" as const }),
          answer: args.answer,
          sources: ids,
          engine: "model",
          steps: history.map((h) => h.call.name),
        };
      }
      if (review)
        throw new MerchantError(
          "REVIEW_READY",
          "A reviewable action is ready. Finish and wait for the owner.",
        );
      switch (name) {
        case "prepare_cancellations": {
          const { proposal_ids, effective } =
            agentTools.prepare_cancellations.input.parse(args);
          const { owner: _owner, ...prepared } =
            await prepareCancellationReview(
              store,
              owner,
              agent!.id,
              proposal_ids,
              effective,
            );
          review = { type: "cancellation", cancellation: prepared };
          result = {
            review_id: prepared.id,
            status: prepared.status,
            effective: prepared.effective,
            services: prepared.entries,
            approval_required: true,
          };
          break;
        }
        case "match_confirmation": {
          const { message_id } =
            agentTools.match_confirmation.input.parse(args);
          sources([message_id]);
          result = await checkConfirmation(store, owner, agent!.id, message_id);
          break;
        }
        case "list_managed_services": {
          result = {
            services: managedServices(store, owner, agent!.id),
            allowance: store.agentAllowance(owner, agent!.id),
          };
          break;
        }
        case "get_service_status": {
          const { proposal_id } =
            agentTools.get_service_status.input.parse(args);
          result = await managedServiceStatus(
            store,
            owner,
            agent!.id,
            proposal_id,
          );
          break;
        }
        case "search_documents": {
          const { query } = agentTools.search_documents.input.parse(args);
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
          result = {
            documents: store
              .documents(owner, agent?.id)
              .filter((d) =>
                terms.every((t) =>
                  `${d.filename} ${d.text}`.toLowerCase().includes(t),
                ),
              )
              .slice(0, 30)
              .map(({ text, ...d }) => ({
                ...d,
                source_id: d.id,
                preview: text.slice(0, 180),
              })),
          };
          break;
        }
        case "read_document": {
          const { document_id, offset } =
            agentTools.read_document.input.parse(args);
          const doc = store.document(owner, document_id, agent?.id);
          if (doc.status !== "readable")
            throw new MerchantError(
              "DOCUMENT_UNREAD",
              doc.limitation ?? "This document has not been read.",
            );
          read.add(doc.id);
          result = {
            ...doc,
            source_id: doc.id,
            text: doc.text.slice(offset, offset + 12000),
            next_offset:
              offset + 12000 < doc.text.length ? offset + 12000 : null,
            truncated: doc.truncated,
          };
          break;
        }
        case "read_tasks": {
          result = { tasks: store.setting<SavedTask[]>(taskKey) ?? [] };
          break;
        }
        case "record_task": {
          const a = agentTools.record_task.input.parse(args);
          const ids = sources(a.sources);
          const tasks = store.setting<SavedTask[]>(taskKey) ?? [];
          const existing = a.task_id
            ? tasks.find((t) => t.id === a.task_id)
            : undefined;
          if (a.task_id && !existing)
            throw new MerchantError(
              "TASK_UNAVAILABLE",
              "Read this agent's tasks before updating a task.",
            );
          if (!existing && tasks.length >= 100)
            throw new MerchantError(
              "TASK_LIMIT",
              "This agent already has 100 tracked tasks.",
            );
          const task: SavedTask = {
            id: existing?.id ?? randomUUID(),
            text: a.text,
            status: a.status,
            sources: ids,
            note: a.note,
            updated_at: store.now().toISOString(),
          };
          store.setSetting(
            taskKey,
            existing
              ? tasks.map((t) => (t.id === existing.id ? task : t))
              : [...tasks, task],
          );
          result = task;
          break;
        }
        case "search_messages": {
          const { query } = agentTools.search_messages.input.parse(args);
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
          const found = messages
            .filter((m) =>
              terms.every((term) =>
                `${m.subject} ${m.from} ${m.text}`.toLowerCase().includes(term),
              ),
            )
            .sort((a, b) => b.received_at.localeCompare(a.received_at));
          result = {
            total: found.length,
            messages: found.slice(0, 20).map((m) => ({
              id: m.id,
              subject: m.subject,
              from: m.from,
              received_at: m.received_at,
              kind: m.kind,
              preview: m.text.slice(0, 180),
              origin: m.origin,
              media: m.media,
            })),
          };
          break;
        }
        case "read_message": {
          const { message_id } = agentTools.read_message.input.parse(args);
          const m = source(message_id);
          read.add(m.id);
          const documents = store
            .documents(owner, agent?.id)
            .filter((d) => d.message_id === m.id)
            .map(({ text: _text, ...d }) => d);
          result = {
            ...m,
            owner: undefined,
            provider_id: undefined,
            text: m.text.slice(0, 12000),
            html: undefined,
            truncated: m.text.length > 12000,
            documents,
          };
          break;
        }
        case "list_services": {
          const { query } = agentTools.list_services.input.parse(args);
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
          const found = (await input.services()).filter((s) =>
            terms.every((term) =>
              JSON.stringify(s).toLowerCase().includes(term),
            ),
          );
          for (const s of found) discovered.set(s.id, s);
          result = {
            services: found,
            scope: "Connected fictional fixture services only",
          };
          break;
        }
        case "get_quote": {
          const a = agentTools.get_quote.input.parse(args);
          const service = discovered.get(a.service_id),
            item = service?.items.find((i) => i.id === a.item_id);
          if (!service || !item)
            throw new MerchantError(
              "ITEM_UNAVAILABLE",
              "Discover the service and item first.",
            );
          if (!item.in_stock)
            throw new MerchantError(
              "OUT_OF_STOCK",
              "That item is unavailable.",
            );
          const quote = await (input.quote ?? merchantTool<Quote>)(
            a.service_id,
            "get_quote",
            {
              item_id: a.item_id,
              quantity: a.quantity,
              ...(a.booking ? { booking: a.booking } : {}),
            },
          );
          if (
            quote.service_id !== a.service_id ||
            quote.item_id !== a.item_id ||
            quote.quantity !== a.quantity ||
            quote.currency !== "USD" ||
            !Number.isSafeInteger(quote.amount_minor) ||
            quote.amount_minor <= 0 ||
            !(new Date(quote.expires_at) > store.now())
          )
            throw new MerchantError(
              "QUOTE_INVALID",
              "The service did not return a valid current quote.",
            );
          quotes.set(quote.id, quote);
          result = quote;
          break;
        }
        case "compare_quotes": {
          const a = agentTools.compare_quotes.input.parse(args);
          const observed = a.quote_ids.map((id) => {
            const q = quotes.get(id);
            if (!q)
              throw new MerchantError(
                "QUOTE_REQUIRED",
                "Get every quote during this run before comparing it.",
              );
            return q;
          });
          const ids = sources(a.offer_source_ids);
          const comparison = compareQuotes({
            quotes: observed,
            offers: ids.map(source),
            now: store.now(),
            maxAmount: a.max_amount_minor,
            availableFor: (serviceId) => {
              const w = store
                .wallets(owner)
                .find(
                  (w) => w.service_id === serviceId && w.agent_id === agent!.id,
                );
              const allowance = store.agentAllowance(owner, agent!.id);
              const total = allowance
                ? allowance.paused || allowance.expired
                  ? 0
                  : allowance.available
                : Number.MAX_SAFE_INTEGER;
              if (!w) return total;
              const p = store.publicWallet(owner, w);
              return Math.min(
                total,
                p.paused ||
                  new Date(p.expires_at) <= store.now() ||
                  p.status === "revoked"
                  ? 0
                  : Math.min(p.available, p.per_action),
              );
            },
          });
          compared = {
            quoteIds: a.quote_ids,
            comparison: comparison.comparison,
          };
          result = comparison;
          break;
        }
        case "list_purchase_rules": {
          const all = store.proposals(owner);
          result = {
            rules: all
              .filter(
                (p) =>
                  p.agent_id === agent!.id &&
                  p.kind === "schedule" &&
                  p.monthly_schedule,
              )
              .map((p) => ({
                proposal_id: p.id,
                status: p.status,
                service_id: p.service_id,
                item_id: p.item_id,
                quantity: p.quantity,
                rule: p.monthly_schedule,
                reason: p.reason,
                next_due_at: nextMonthlyDue(
                  p.monthly_schedule!,
                  store.now(),
                  monthlyPeriodHasPurchase(store, owner, p, store.now()),
                ),
                purchases: all
                  .filter((c) => c.scheduled_by?.proposal_id === p.id)
                  .map((c) => ({
                    proposal_id: c.id,
                    period: c.scheduled_by!.period,
                    status: c.status,
                    amount: c.amount,
                    capture_id: c.capture_id,
                  })),
              })),
          };
          break;
        }
        case "prepare_purchase_schedule": {
          const a = agentTools.prepare_purchase_schedule.input.parse(args),
            quote = quotes.get(a.quote_id);
          if (!quote || !(new Date(quote.expires_at) > store.now()))
            throw new MerchantError(
              "QUOTE_REQUIRED",
              "Get a current quote during this run before preparing a monthly purchase rule.",
            );
          if (
            store
              .proposals(owner)
              .some(
                (p) =>
                  p.kind === "schedule" &&
                  p.status === "WAITING" &&
                  p.agent_id === agent!.id &&
                  p.service_id === quote.service_id &&
                  p.item_id === quote.item_id,
              )
          )
            throw new MerchantError(
              "SCHEDULE_EXISTS",
              "An approved rule already covers this exact item. The owner must stop it before approving a replacement.",
            );
          const ids = sources(a.sources);
          const proposal = await input.propose(quote.service_id, "schedule", {
            title: `Monthly ${quote.item_name}`,
            quantity: quote.quantity,
            item_id: quote.item_id,
            quote,
            booking: null,
            sources: ids,
            rationale: a.rationale,
            owner_request: input.text,
            agent_id: agent!.id,
            monthly_schedule: a.rule,
          });
          review = { type: "proposal", proposal };
          result = {
            proposal_id: proposal.id,
            status: proposal.status,
            rule: proposal.monthly_schedule,
            owner_approval_required: true,
            payment_consent_required: true,
            wallet: store.publicWallet(
              owner,
              store.wallet(owner, proposal.wallet_id),
            ),
            next_due_at: nextMonthlyDue(
              proposal.monthly_schedule!,
              store.now(),
            ),
            action:
              "Prepared only. The rule is not active and no payment was made.",
          };
          break;
        }
        case "prepare_proposal": {
          const a = agentTools.prepare_proposal.input.parse(args),
            quote = quotes.get(a.quote_id);
          if (!quote || !(new Date(quote.expires_at) > store.now()))
            throw new MerchantError(
              "QUOTE_REQUIRED",
              "Get a current quote during this run first.",
            );
          const ids = sources(a.sources);
          const wallet = store
            .wallets(owner)
            .find(
              (w) =>
                w.service_id === quote.service_id && w.agent_id === agent!.id,
            );
          if (agent && wallet?.agent_id && wallet.agent_id !== agent.id)
            throw new MerchantError(
              "SCOPE_MISMATCH",
              "That wallet belongs to another agent.",
            );
          if (quote.kind === "subscription") {
            const related = store
              .proposals(owner)
              .filter(
                (p) =>
                  p.wallet_id === wallet?.id &&
                  p.item_id === quote.item_id &&
                  (p.agent_id ?? wallet?.agent_id) === agent!.id,
              );
            if (
              related.some((p) => ["PAYING", "RECONCILING"].includes(p.status))
            )
              throw new MerchantError(
                "SERVICE_PAYMENT_PENDING",
                "This service has an unresolved payment. Check its status before preparing another purchase.",
              );
            const paid = related.find((p) => p.status === "PAID");
            if (paid) {
              const current = await managedServiceStatus(
                store,
                owner,
                agent!.id,
                paid.id,
              );
              if (!current.payment_confirmed || !current.identity_verified)
                throw new MerchantError(
                  "SERVICE_REVIEW_REQUIRED",
                  "The previous payment or identity could not be verified. Check the existing service before preparing another purchase.",
                );
              if (current.access_active)
                throw new MerchantError(
                  "SERVICE_ALREADY_ACTIVE",
                  "This agent already has verified active access to this item. Another purchase was not prepared.",
                );
            }
          }
          const proposal = await input.propose(
            quote.service_id,
            a.condition_under_minor !== null
              ? "condition"
              : quote.kind === "subscription"
                ? "subscribe"
                : quote.kind === "booking"
                  ? "book"
                  : "buy",
            {
              title:
                a.condition_under_minor !== null
                  ? `Buy ${quote.item_name} when its price drops`
                  : quote.kind === "booking"
                    ? `Reserve ${quote.item_name}`
                    : quote.kind === "subscription"
                      ? `One month of ${discovered.get(quote.service_id)!.name}`
                      : quote.item_name,
              quantity: quote.quantity,
              item_id: quote.item_id,
              quote,
              booking: quote.booking ?? null,
              sources: ids,
              rationale: a.rationale,
              owner_request: input.text,
              ...(compared?.quoteIds.includes(quote.id)
                ? {
                    comparison: {
                      ...compared.comparison,
                      selected_item_id: quote.item_id,
                      selected_service_id: quote.service_id,
                    },
                  }
                : {}),
              ...(agent ? { agent_id: agent.id } : {}),
              ...(a.condition_under_minor !== null
                ? { under: a.condition_under_minor }
                : {}),
            },
          );
          review = { type: "proposal", proposal };
          result = {
            proposal_id: proposal.id,
            status: proposal.status,
            title: proposal.title,
            amount: proposal.amount,
            action: "Prepared only; owner approval required",
          };
          break;
        }
        case "prepare_reply": {
          const a = agentTools.prepare_reply.input.parse(args),
            m = source(a.message_id);
          const pending =
            agent &&
            store.setting<{ id?: string }>(`agent-reply:${owner}:${agent.id}`);
          const attempted =
            pending?.id &&
            store.setting<{ sent_at?: string }>(
              `reply-sent:${owner}:${pending.id}`,
            );
          if (attempted && !attempted.sent_at)
            throw new MerchantError(
              "REPLY_PENDING",
              "Resolve the original pending send before replacing this agent's draft.",
            );
          const evidence = sources([
            a.message_id,
            ...a.sources,
            ...a.document_ids,
          ]);
          const documents = a.document_ids.map((id) =>
            store.document(owner, id, agent?.id),
          );
          const addresses = replyAddresses(m);
          if (
            m.origin === "agentmail" &&
            (!addresses.length || m.reply_to === undefined)
          )
            throw new MerchantError(
              "REPLY_ROUTING_REQUIRED",
              "Refresh the agent inbox to verify the reply recipient before preparing a send review.",
            );
          if (documents.some((d) => d.status !== "readable"))
            throw new MerchantError(
              "DOCUMENT_UNREAD",
              "Only readable documents can be prepared as attachments.",
            );
          if (documents.reduce((sum, d) => sum + d.size, 0) > 3 * 1024 * 1024)
            throw new MerchantError(
              "ATTACHMENT_LIMIT",
              "Choose attachments totalling no more than 3 MB.",
            );
          review = {
            type: "reply",
            draft: {
              id: randomUUID(),
              message_id: m.id,
              service_id: m.service_id,
              to_name: m.from.replace(/\s*<[^>]*>\s*$/, "").trim(),
              to_address: addresses.join(", "),
              subject: m.subject,
              body: a.body,
              sources: evidence,
              documents: documents.map((d) => ({
                id: d.id,
                filename: d.filename,
              })),
            },
          };
          if (m.agent_id)
            store.setSetting(
              `agent-reply:${owner}:${m.agent_id}`,
              review.draft,
            );
          result = {
            status: "DRAFT",
            message_id: m.id,
            attachments: documents.map((d) => d.filename),
            sent: false,
          };
          break;
        }
        case "search_market": {
          const { query } = agentTools.search_market.input.parse(args);
          market = await searchMarket(query);
          result = market;
          break;
        }
      }
      store.log(
        owner,
        "AGENT_TOOL_COMPLETED",
        activity[name] ?? name,
        null,
        null,
        agent?.id,
        runId,
      );
    } catch (error) {
      // Tool errors are observations. Let the model revise its approach; do not
      // expose provider errors, credentials or unrelated records to it.
      result = {
        error: error instanceof MerchantError ? error.code : "TOOL_FAILED",
        message:
          error instanceof MerchantError
            ? error.message
            : "This capability could not complete. Check its input or explain the limitation.",
      };
      store.log(
        owner,
        "AGENT_TOOL_FAILED",
        "A step could not complete; the agent received the limitation.",
        null,
        null,
        agent?.id,
        runId,
      );
    }
    history.push({ call, result });
  }
  store.log(
    owner,
    "AGENT_STOPPED",
    "Stopped at the step limit. Prepared actions still need review.",
    null,
    null,
    agent?.id,
    runId,
  );
  return {
    ...(review ?? { type: "answer" as const }),
    answer:
      "I reached the step limit. Any prepared action still needs your review; nothing was sent or paid. Try a narrower request.",
    sources: [...read],
    engine: "model",
    steps: history.map((h) => h.call.name),
  };
}
