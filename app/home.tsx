"use client";
import type { AppState, Message } from "../src/app-model";
import {
  isExpiredOffer,
  money,
  needsYou,
  proposalPrice,
  proposalPriceLabel,
  proposalVerb,
  senderName,
  shortDate,
  walletBelongs,
  readyAgentIds,
} from "./agent-scope";
import { Badge, Button, LinkButton, SectionHead } from "./ui";
import { Avatar, lookFor } from "./ui/avatar";

export function Home({
  state,
  busy,
  onOpenAgent,
  onOpenMessage,
  onDecline,
  onPayInvoice,
  onDismiss,
  onCreate,
  onLoadDemo,
}: {
  state: AppState;
  busy: boolean;
  onOpenAgent: (id: string) => void;
  onOpenMessage: (message: Message) => void;
  onDecline: (proposalId: string) => void;
  onPayInvoice: (message: Message, agentId: string) => void;
  onDismiss: (message: Message) => void;
  onCreate: () => void;
  onLoadDemo: () => void;
}) {
  const agents = (state.agents ?? []).filter((a) => !a.archived_at);
  const ready = readyAgentIds(state);
  const visibleAgents = ready.size
    ? agents.filter((a) => ready.has(a.id))
    : agents;
  if (!agents.length)
    return (
      <div className="ui-col">
        <h1 className="ui-title">Create your first agent</h1>
        <p className="ui-sub">
          Give it one job and its own address, then use that address for the
          services that belong to that job.
        </p>
        <div className="ui-empty">
          <div className="ui-actions">
            <Button variant="primary" onClick={onCreate}>
              Create agent
            </Button>
            <Button onClick={onLoadDemo} disabled={busy}>
              Load sample agents
            </Button>
          </div>
        </div>
      </div>
    );

  const needs = needsYou(state);
  const lead = needs[0]?.kind === "approval" ? needs[0] : null;
  const rest = lead ? needs.slice(1) : needs;
  const expired = agents
    .map((agent) => ({
      agent,
      count: state.messages.filter(
        (m) => m.agent_id === agent.id && isExpiredOffer(m),
      ).length,
    }))
    .filter((entry) => entry.count > 0);
  const expiredTotal = expired.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <div className="ui-col">
      <h1 className="ui-title">
        {needs.length === 0
          ? "Nothing needs you"
          : `${needs.length} thing${needs.length > 1 ? "s" : ""} need${needs.length > 1 ? "" : "s"} you`}
      </h1>
      {needs.length === 0 && (
        <p className="ui-sub">
          Approvals, invoices and blocked messages from every agent appear here.
        </p>
      )}

      {lead && (
        <section className="ui-card" aria-label="Waiting for your approval">
          <div className="ui-card-top">
            <div>
              <div className="ui-card-who">
                <Avatar look={lookFor(lead.agent, lead.agentIndex)} />
                {lead.agent.name} {proposalVerb(lead.proposal)}
              </div>
              <h2 className="ui-card-title">{lead.proposal.title}</h2>
              <p>
                {lead.wallet.name}. {lead.proposal.rationale}
              </p>
            </div>
            <div className="ui-price">
              {proposalPrice(lead.proposal)}
              <small>{proposalPriceLabel(lead.proposal)}</small>
            </div>
          </div>
          <div className="ui-card-foot">
            <p className="ui-card-ctx">
              {money(lead.wallet.available)} left in this wallet this{" "}
              {lead.wallet.period}
            </p>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onDecline(lead.proposal.id)}
            >
              Decline
            </Button>
            <Button
              variant="primary"
              onClick={() => onOpenAgent(lead.agent.id)}
            >
              Review proposal
            </Button>
          </div>
        </section>
      )}

      {rest.length > 0 && (
        <div className="ui-rows is-spaced">
          {rest.map((need) =>
            need.kind === "approval" ? (
              <div className="ui-row" key={need.proposal.id}>
                <Avatar look={lookFor(need.agent, need.agentIndex)} />
                <span>
                  <span className="ui-row-title">
                    {need.proposal.title} · {proposalPrice(need.proposal)}
                    <Badge tone="warn">Needs approval</Badge>
                  </span>
                  <span className="ui-row-detail">
                    {need.agent.name} · {need.wallet.name}
                  </span>
                </span>
                <Button onClick={() => onOpenAgent(need.agent.id)}>
                  Review proposal
                </Button>
              </div>
            ) : (
              <div className="ui-row" key={need.message.id}>
                <Avatar look={lookFor(need.agent, need.agentIndex)} />
                <span>
                  <span className="ui-row-title">
                    <LinkButton
                      className="is-plain"
                      onClick={() => onOpenMessage(need.message)}
                    >
                      {need.kind === "flagged"
                        ? `A message tried to give ${need.agent.name} instructions`
                        : need.message.subject}
                    </LinkButton>
                    {need.kind === "flagged" ? (
                      <Badge tone="danger">Blocked</Badge>
                    ) : (
                      <Badge tone="warn">Invoice</Badge>
                    )}
                  </span>
                  <span className="ui-row-detail">
                    {need.agent.name} · {senderName(need.message.from)} ·{" "}
                    {need.kind === "flagged"
                      ? `"${need.message.subject}" · no payment was authorized`
                      : `received ${shortDate(need.message.received_at)}`}
                  </span>
                </span>
                {need.kind === "flagged" ? (
                  <Button
                    aria-label={`Dismiss: ${need.message.subject}`}
                    disabled={busy}
                    onClick={() => onDismiss(need.message)}
                  >
                    Dismiss
                  </Button>
                ) : need.message.facts.amount_minor ? (
                  <Button
                    aria-label={`Pay ${money(need.message.facts.amount_minor)}: ${need.message.subject}`}
                    disabled={busy}
                    onClick={() => onPayInvoice(need.message, need.agent.id)}
                  >
                    Pay {money(need.message.facts.amount_minor)}
                  </Button>
                ) : (
                  <Button onClick={() => onOpenMessage(need.message)}>
                    Open message
                  </Button>
                )}
              </div>
            ),
          )}
        </div>
      )}

      <SectionHead title="Agents">
        <LinkButton onClick={onCreate}>New agent</LinkButton>
      </SectionHead>
      <div className="ui-rows">
        {visibleAgents.map((agent) => {
          const index = agents.indexOf(agent);
          const count = state.messages.filter(
            (m) => m.agent_id === agent.id,
          ).length;
          const wallets = state.wallets.filter((w) => walletBelongs(w, agent));
          const spent = wallets.reduce((sum, w) => sum + w.spent, 0);
          const cap = wallets.reduce((sum, w) => sum + w.cap, 0);
          return (
            <button
              className="ui-row is-agent"
              key={agent.id}
              onClick={() => onOpenAgent(agent.id)}
            >
              <Avatar look={lookFor(agent, index)} />
              <span className="ui-row-title">
                {agent.name}{" "}
                <span className="ui-quiet">{agent.tags.join(", ")}</span>
              </span>
              <span className="ui-row-detail ui-hide-sm">
                {agent.email ? (
                  <span className="ui-mono">{agent.email}</span>
                ) : (
                  "No address yet"
                )}
              </span>
              <span className="ui-row-num ui-hide-sm">
                {count} message{count === 1 ? "" : "s"}
              </span>
              <span className="ui-row-num">
                {wallets.length === 0 ? (
                  <span className="ui-quiet">No wallet</span>
                ) : wallets.length === 1 ? (
                  `${money(spent)} of ${money(cap)}`
                ) : (
                  `${money(spent)} spent · ${wallets.length} services`
                )}
              </span>
            </button>
          );
        })}
      </div>

      {expiredTotal > 0 && (
        <>
          <SectionHead title="Handled without you" />
          <p className="ui-sub is-flush">
            {expiredTotal} expired offer{expiredTotal > 1 ? "s" : ""} set aside
            ({expired.map((entry) => entry.agent.name).join(", ")}).
          </p>
        </>
      )}
    </div>
  );
}
