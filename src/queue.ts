import type {
  AppState,
  Message,
  Proposal,
  PublicAgent,
  PublicWallet,
} from "./app-model.ts";

/*
 * What is waiting on the owner, and the digest of one agent's messages.
 * Pure functions over the app state, shared by the server and the screens.
 */

export function walletBelongs(wallet: PublicWallet, agent: PublicAgent) {
  return (
    wallet.agent_id === agent.id ||
    (!wallet.agent_id && agent.template === wallet.category)
  );
}

export function proposalBelongs(
  state: Pick<AppState, "wallets">,
  proposal: Proposal,
  agent: PublicAgent,
) {
  return (
    proposal.agent_id === agent.id ||
    (!proposal.agent_id &&
      state.wallets.some(
        (wallet) =>
          wallet.id === proposal.wallet_id && walletBelongs(wallet, agent),
      ))
  );
}

export const isExpiredOffer = (message: Message, now = new Date()) =>
  message.kind === "offer" &&
  !!message.facts.expires &&
  new Date(message.facts.expires) < now;

/** An active paid month already satisfies other requests for that subscription. */
export function isDuplicateSubscription(
  state: Pick<AppState, "proposals">,
  proposal: Proposal,
  now = new Date(),
) {
  if (
    proposal.kind !== "subscribe" ||
    !["NEEDS_APPROVAL", "APPROVED"].includes(proposal.status)
  )
    return false;
  return state.proposals.some(
    (other) =>
      other.id !== proposal.id &&
      other.wallet_id === proposal.wallet_id &&
      other.kind === "subscribe" &&
      other.status === "PAID" &&
      (!other.period_end || new Date(other.period_end) > now) &&
      (!other.cancel_effective_at || new Date(other.cancel_effective_at) > now),
  );
}

export type Need =
  | {
      kind: "approval";
      agent: PublicAgent;
      agentIndex: number;
      proposal: Proposal;
      wallet: PublicWallet;
    }
  | {
      kind: "invoice" | "flagged";
      agent: PublicAgent;
      agentIndex: number;
      message: Message;
    };

type QueueState = Pick<
  AppState,
  "agents" | "wallets" | "proposals" | "messages" | "dismissed"
>;

/** Everything waiting on the owner, across agents: approvals first, then mail. */
export function needsYou(state: QueueState): Need[] {
  const approvals: Need[] = [];
  const mail: Need[] = [];
  state.agents.forEach((agent, agentIndex) => {
    if (agent.archived_at) return;
    for (const proposal of state.proposals) {
      if (proposal.status !== "NEEDS_APPROVAL") continue;
      if (isDuplicateSubscription(state, proposal)) continue;
      if (!proposalBelongs(state, proposal, agent)) continue;
      const wallet = state.wallets.find((w) => w.id === proposal.wallet_id);
      if (wallet)
        approvals.push({
          kind: "approval",
          agent,
          agentIndex,
          proposal,
          wallet,
        });
    }
    for (const message of state.messages) {
      if (message.agent_id !== agent.id) continue;
      if (message.facts.suspicious) {
        // A blocked message waits until the owner dismisses it.
        if (!state.dismissed.includes(message.id))
          mail.push({ kind: "flagged", agent, agentIndex, message });
      } else if (message.kind === "invoice") {
        // An invoice waits until a proposal to pay it is open or paid.
        const handled = state.proposals.some(
          (proposal) =>
            proposal.sources.includes(message.id) &&
            !["DECLINED", "BLOCKED", "EXPIRED"].includes(proposal.status),
        );
        if (!handled)
          mail.push({ kind: "invoice", agent, agentIndex, message });
      }
    }
  });
  return [...approvals, ...mail];
}

/** The opening of a message, short enough for one line. */
export function gist(text: string, limit = 120) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const sentence = flat.slice(0, limit + 1).match(/^.*[.!?](?=\s)/)?.[0];
  if (sentence && sentence.length >= 40) return sentence;
  return `${flat.slice(0, flat.lastIndexOf(" ", limit))}…`;
}

export type DigestLine = { message: Message; text: string };
export type Digest = {
  count: number;
  /** ISO time of the oldest message covered, or null when there are none. */
  since: string | null;
  needs: Need[];
  /** Current information: offers still open, receipts, renewals, confirmations. */
  notable: DigestLine[];
  /** Read and set aside: expired offers and delivery checks. */
  aside: DigestLine[];
};

/** One agent's messages, sorted by what the owner would do with them. */
export function digestFor(
  state: QueueState,
  agent: PublicAgent,
  now = new Date(),
): Digest {
  const messages = state.messages
    .filter((message) => message.agent_id === agent.id)
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
  const needs = needsYou(state).filter((need) => need.agent.id === agent.id);
  const waiting = new Set(
    needs.flatMap((need) =>
      need.kind === "approval" ? [] : [need.message.id],
    ),
  );
  const notable: DigestLine[] = [];
  const aside: DigestLine[] = [];
  for (const message of messages) {
    // Blocked mail is never quoted: its text is what tried to instruct the agent.
    if (message.facts.suspicious || waiting.has(message.id)) continue;
    const line = { message, text: gist(message.text) };
    if (isExpiredOffer(message, now) || message.kind === "verification")
      aside.push(line);
    else notable.push(line);
  }
  return {
    count: messages.length,
    since: messages.at(-1)?.received_at ?? null,
    needs,
    notable,
    aside,
  };
}
