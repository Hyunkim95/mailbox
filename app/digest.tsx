"use client";
import type { AppState, Message, PublicAgent } from "../src/app-model";
import {
  digestFor,
  money,
  proposalPrice,
  senderName,
  shortDate,
} from "./agent-scope";
import { Badge, Button, LinkButton } from "./ui";

/** One agent's messages, sorted by what the owner would do with them. */
export function Digest({
  state,
  agent,
  busy,
  onOpenMessage,
  onReviewProposal,
  onPayInvoice,
  onDismiss,
}: {
  state: AppState;
  agent: PublicAgent;
  busy: boolean;
  onOpenMessage: (message: Message) => void;
  onReviewProposal: () => void;
  onPayInvoice: (message: Message) => void;
  onDismiss: (message: Message) => void;
}) {
  const digest = digestFor(state, agent);
  const senders = [
    ...new Set(
      state.messages
        .filter((message) => message.agent_id === agent.id)
        .map((message) => senderName(message.from)),
    ),
  ];
  const lines = (items: typeof digest.notable) => (
    <ul className="ui-list">
      {items.map(({ message, text }) => (
        <li key={message.id}>
          {text}{" "}
          <LinkButton onClick={() => onOpenMessage(message)}>
            {message.subject}
          </LinkButton>
        </li>
      ))}
    </ul>
  );
  return (
    <section className="ui-card" aria-label="Digest">
      <div className="ui-card-top">
        <div>
          <div className="ui-card-who">
            {digest.count === 0
              ? `${agent.name} has no messages yet`
              : `${digest.count} message${digest.count > 1 ? "s" : ""}${senders.length === 1 ? ` from ${senders[0]}` : ""}${digest.since ? ` since ${shortDate(digest.since)}` : ""}`}
          </div>
          <h2 className="ui-card-title">
            {digest.count === 0
              ? "Nothing to report"
              : digest.needs.length === 0
                ? "Nothing needs you. Here is what came in."
                : `${digest.needs.length} thing${digest.needs.length > 1 ? "s need" : " needs"} you. The rest is information.`}
          </h2>
        </div>
      </div>
      {digest.count === 0 ? (
        <div className="ui-card-body">
          <p>
            {agent.email
              ? `Messages sent to ${agent.email} are summarized here.`
              : `Create an address for ${agent.name} and use it for the services you choose. Their messages are summarized here.`}
          </p>
        </div>
      ) : (
        <div className="ui-card-body">
          {digest.needs.length > 0 && (
            <>
              <h3 className="ui-sublabel">Needs you</h3>
              <div className="ui-rows is-bare">
                {digest.needs.map((need) =>
                  need.kind === "approval" ? (
                    <div className="ui-row is-plain" key={need.proposal.id}>
                      <span>
                        <span className="ui-row-title">
                          {need.proposal.title} · {proposalPrice(need.proposal)}
                          <Badge tone="warn">Needs approval</Badge>
                        </span>
                        <span className="ui-row-detail">
                          {need.wallet.name}
                        </span>
                      </span>
                      <Button onClick={onReviewProposal}>
                        Review proposal
                      </Button>
                    </div>
                  ) : (
                    <div className="ui-row is-plain" key={need.message.id}>
                      <span>
                        <span className="ui-row-title">
                          <LinkButton
                            className="is-plain"
                            onClick={() => onOpenMessage(need.message)}
                          >
                            {need.kind === "flagged"
                              ? `A message tried to give ${agent.name} instructions`
                              : need.message.subject}
                          </LinkButton>
                          {need.kind === "flagged" ? (
                            <Badge tone="danger">Blocked</Badge>
                          ) : (
                            <Badge tone="warn">Invoice</Badge>
                          )}
                        </span>
                        <span className="ui-row-detail">
                          {senderName(need.message.from)} ·{" "}
                          {need.kind === "flagged"
                            ? "no payment was authorized"
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
                          onClick={() => onPayInvoice(need.message)}
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
            </>
          )}
          {digest.notable.length > 0 && (
            <>
              <h3 className="ui-sublabel">Worth knowing</h3>
              {lines(digest.notable)}
            </>
          )}
          {digest.aside.length > 0 && (
            <>
              <h3 className="ui-sublabel">Set aside</h3>
              {lines(digest.aside)}
            </>
          )}
        </div>
      )}
    </section>
  );
}
