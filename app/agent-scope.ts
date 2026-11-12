import type { Proposal, AppState } from "../src/app-model";

export function readyAgentIds(state: AppState) {
  return new Set(
    state.agents
      .filter(
        (a) =>
          !a.archived_at &&
          ((a.status === "connected" && !!a.email) ||
            state.wallets.some(
              (w) =>
                w.agent_id === a.id &&
                (w.connected || w.spent > 0 || w.reserved > 0),
            ) ||
            state.proposals.some(
              (p) =>
                p.agent_id === a.id &&
                (["PAID", "PAYING", "RECONCILING"].includes(p.status) ||
                  p.reserved > 0),
            )),
      )
      .map((a) => a.id),
  );
}
/** Keep unfinished setup accessible without mixing previews into connected work. */
export function connectedWorkspace(state: AppState): AppState {
  const ids = readyAgentIds(state);
  if (!ids.size) {
    if (!state.agents.some((a) => a.archived_at)) return state;
    for (const agent of state.agents) if (!agent.archived_at) ids.add(agent.id);
  }
  const wallets = state.wallets.filter(
    (w) => w.agent_id && ids.has(w.agent_id),
  );
  const walletIds = new Set(wallets.map((w) => w.id));
  return {
    ...state,
    wallets,
    proposals: state.proposals.filter((p) =>
      p.agent_id ? ids.has(p.agent_id) : walletIds.has(p.wallet_id),
    ),
    messages: state.messages.filter((m) => m.agent_id && ids.has(m.agent_id)),
    tasks: (state.tasks ?? []).filter((t) => ids.has(t.agent_id)),
    documents: (state.documents ?? []).filter((d) => ids.has(d.agent_id)),
    reply_drafts: (state.reply_drafts ?? []).filter((r) => ids.has(r.agent_id)),
    agent_allowances: (state.agent_allowances ?? []).filter((a) =>
      ids.has(a.agent_id),
    ),
    cancellation_reviews: (state.cancellation_reviews ?? []).filter((r) =>
      ids.has(r.agent_id),
    ),
  };
}

export const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );

export const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Dubai",
  });

/** "Daily Paws <offers@example.com>" becomes "Daily Paws". */
export const senderName = (from: string) =>
  from.replace(/\s*<[^>]*>\s*$/, "").trim() || from;

export {
  digestFor,
  isExpiredOffer,
  isDuplicateSubscription,
  needsYou,
  proposalBelongs,
  walletBelongs,
  type Digest,
  type Need,
} from "../src/queue";

export const proposalVerb = (proposal: Proposal) =>
  proposal.kind === "schedule"
    ? "wants to schedule monthly purchases"
    : proposal.kind === "subscribe"
      ? "wants to subscribe"
      : proposal.kind === "book"
        ? "wants to book"
        : proposal.kind === "condition"
          ? "wants to set a price rule"
          : "wants to buy";

export const proposalPrice = (proposal: Proposal) =>
  proposal.kind === "schedule" && proposal.monthly_schedule
    ? `${proposal.monthly_schedule.price_inclusive ? "Up to" : "Below"} ${money(proposal.monthly_schedule.max_amount_minor)}`
    : proposal.kind === "condition"
      ? `Below ${money(proposal.condition_under ?? 3000)}`
      : money(proposal.amount);

export const proposalPriceLabel = (proposal: Proposal) =>
  proposal.kind === "schedule"
    ? "one exact-item purchase per month"
    : proposal.kind === "subscribe"
      ? "one paid month, no renewal"
      : proposal.kind === "book"
        ? "booking deposit"
        : proposal.kind === "condition"
          ? "one purchase, exact variant"
          : "all-in total";
