import { MerchantError, type Action } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Proposal } from "./app-model.ts";
import { merchantTool } from "./service-connector.ts";

export function serviceActionWallet(
  store: AppStore,
  owner: string,
  agentId: string,
  proposal: Proposal,
) {
  const wallet = store.wallet(owner, proposal.wallet_id);
  if (
    (proposal.agent_id ?? wallet.agent_id) !== agentId ||
    (wallet.agent_id && wallet.agent_id !== agentId)
  )
    throw new MerchantError(
      "NOT_FOUND",
      "That service action is not available to this agent.",
    );
  return wallet;
}

export function managedServices(
  store: AppStore,
  owner: string,
  agentId: string,
) {
  store.agent(owner, agentId);
  const messages = store
    .messages(owner)
    .filter((m) => m.agent_id === agentId && !m.facts.suspicious);
  return store
    .wallets(owner)
    .filter((w) => w.agent_id === agentId)
    .map((wallet) => ({
      service_id: wallet.service_id,
      name: wallet.name,
      wallet: store.publicWallet(owner, wallet),
      actions: store
        .proposals(owner)
        .filter(
          (p) =>
            p.wallet_id === wallet.id &&
            (p.agent_id ?? wallet.agent_id) === agentId,
        )
        .slice(0, 30)
        .map((p) => ({
          proposal_id: p.id,
          title: p.title,
          item_id: p.item_id,
          kind: p.kind,
          status: p.status,
          amount: p.amount,
          quantity: p.quantity,
          period_end: p.period_end,
          cancel_effective_at: p.cancel_effective_at,
          has_verified_capture: p.status === "PAID" && !!p.capture_id,
          received_confirmation_sources: messages
            .filter(
              (m) =>
                m.service_id === p.service_id &&
                m.origin === "agentmail" &&
                m.facts.action_id === p.merchant_action_id &&
                m.facts.amount_minor === p.amount,
            )
            .map((m) => m.id),
        })),
    }));
}

/** A payment record, merchant fulfillment and delivered email remain distinct evidence. */
export async function managedServiceStatus(
  store: AppStore,
  owner: string,
  agentId: string,
  proposalId: string,
  status: typeof merchantTool<Action> = merchantTool<Action>,
) {
  const agent = store.agent(owner, agentId),
    proposal = store.proposal(owner, proposalId);
  const wallet = serviceActionWallet(store, owner, agentId, proposal);
  if (!proposal.merchant_action_id)
    return {
      proposal_id: proposal.id,
      local_status: proposal.status,
      merchant_status: null,
      payment_confirmed: false,
      access_active: false,
      identity_verified: false,
      wallet: store.publicWallet(owner, wallet),
      limitation: "No merchant action has been dispatched for this proposal.",
    };
  const remote = await status(
    proposal.service_id,
    "get_status",
    {
      action_id: proposal.merchant_action_id,
    },
    proposal.history_source?.base_url,
  );
  if (
    remote.id !== proposal.merchant_action_id ||
    remote.service_id !== proposal.service_id ||
    remote.quote.service_id !== proposal.service_id ||
    remote.quote.item_id !== proposal.item_id ||
    remote.quote.quantity !== proposal.quantity ||
    remote.quote.amount_minor !== proposal.amount ||
    remote.quote.currency !== "USD"
  )
    throw new MerchantError(
      "STATUS_MISMATCH",
      "The merchant status does not match this agent's recorded service action.",
    );
  const paid =
    proposal.status === "PAID" &&
    !!proposal.capture_id &&
    remote.capture_id === proposal.capture_id;
  const identity =
    !!agent.email &&
    remote.address === agent.email &&
    wallet.email === agent.email;
  const end = remote.period_end ? new Date(remote.period_end) : null;
  const access =
    paid &&
    identity &&
    remote.status === "ACTIVE" &&
    !!end &&
    end > store.now();
  const receipts = store
    .messages(owner)
    .filter(
      (m) =>
        m.agent_id === agentId &&
        m.service_id === proposal.service_id &&
        !m.facts.suspicious &&
        m.origin === "agentmail" &&
        m.facts.action_id === remote.id &&
        m.facts.amount_minor === proposal.amount,
    );
  return {
    proposal_id: proposal.id,
    service_id: proposal.service_id,
    item: remote.quote.item_name,
    quantity: proposal.quantity,
    amount: proposal.amount,
    local_status: proposal.status,
    merchant_status: remote.status,
    payment_confirmed: paid,
    identity_verified: identity,
    agent_address: agent.email,
    merchant_address: remote.address,
    access_active: access,
    fulfilled: paid && identity && remote.status === "CONFIRMED",
    period_end: remote.period_end ?? null,
    renewal_disabled: remote.renewal_disabled ?? null,
    cancel_effective_at: remote.cancel_effective_at ?? null,
    received_confirmation_sources: receipts.map((m) => m.id),
    wallet: store.publicWallet(owner, wallet),
    checked_at: store.now().toISOString(),
    limitation: !paid
      ? "The local payment and merchant capture have not been matched."
      : !identity
        ? "The merchant address does not match this agent's current identity."
        : null,
  };
}
