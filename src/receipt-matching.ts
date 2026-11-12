import { MerchantError } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Message, PersonalAgent, Proposal } from "./app-model.ts";
import { explicitCurrency } from "./email-content.ts";
import { managedServiceStatus } from "./managed-services.ts";

function address(value: string) {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}
export function confirmationMatch(
  message: Message,
  agent: PersonalAgent,
  proposals: Pick<
    Proposal,
    | "id"
    | "agent_id"
    | "service_id"
    | "status"
    | "capture_id"
    | "merchant_action_id"
    | "amount"
  >[],
) {
  if (
    message.agent_id !== agent.id ||
    message.origin !== "agentmail" ||
    message.facts.suspicious
  )
    return {
      status: "unverified" as const,
      reason:
        "This is not an eligible delivered message in this agent's inbox.",
    };
  if (!["receipt", "confirmation"].includes(message.kind))
    return {
      status: "unverified" as const,
      reason: "This message is not identified as a receipt or confirmation.",
    };
  const recipient =
    !!agent.email &&
    (message.recipients?.length
      ? message.recipients.some((to) => address(to) === address(agent.email!))
      : !!agent.inbox_id &&
        message.provider_id?.startsWith(`${agent.inbox_id}:`));
  if (!recipient)
    return {
      status: "unverified" as const,
      reason: "Delivery to this agent's identity has not been verified.",
    };
  const currency = explicitCurrency(message.text);
  if (!currency)
    return {
      status: "ambiguous" as const,
      reason: "The message does not provide one unambiguous explicit currency.",
    };
  const candidates = proposals.filter(
    (p) =>
      p.agent_id === agent.id &&
      p.service_id === message.service_id &&
      p.status === "PAID" &&
      p.capture_id &&
      p.merchant_action_id &&
      message.facts.action_id === p.merchant_action_id &&
      message.text.includes(p.merchant_action_id),
  );
  if (!candidates.length)
    return {
      status: "unmatched" as const,
      reason:
        "No authorized paid action matches this message's reference in this agent's records.",
    };
  if (candidates.length > 1)
    return {
      status: "ambiguous" as const,
      reason:
        "More than one recorded payment matches the reference; owner review is needed.",
    };
  const proposal = candidates[0]!;
  if (
    currency !== "USD" ||
    (message.facts.currency && message.facts.currency !== currency) ||
    message.facts.amount_minor !== proposal.amount
  )
    return {
      status: "mismatch" as const,
      reason:
        "The receipt amount or currency does not match the recorded payment.",
    };
  return {
    status: "matched" as const,
    proposal_id: proposal.id,
    currency,
    amount: proposal.amount,
    reference: proposal.merchant_action_id,
    reason:
      "Reference, explicit currency, amount and agent recipient match one recorded payment. Payment evidence does not replace an invoice document.",
  };
}

export async function checkConfirmation(
  store: AppStore,
  owner: string,
  agentId: string,
  messageId: string,
) {
  const agent = store.agent(owner, agentId),
    message = store
      .messages(owner)
      .find((m) => m.id === messageId && m.agent_id === agentId);
  if (!message)
    throw new MerchantError(
      "NOT_FOUND",
      "That confirmation is not available to this agent.",
    );
  const match = confirmationMatch(message, agent, store.proposals(owner));
  if (match.status !== "matched") return match;
  const current = await managedServiceStatus(
    store,
    owner,
    agentId,
    match.proposal_id,
  );
  if (!current.payment_confirmed || !current.identity_verified)
    return {
      status: "unverified" as const,
      reason:
        "The merchant capture or agent identity could not be independently matched.",
      payment: current,
    };
  return { ...match, payment: current, source_id: message.id };
}
