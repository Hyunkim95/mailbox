"use client";
import { Check, Clock, RefreshCw } from "lucide-react";
import type {
  Message,
  Proposal,
  PublicAgent,
  PublicWallet,
} from "../src/app-model";
import {
  money,
  proposalPrice,
  proposalPriceLabel,
  shortDate,
} from "./agent-scope";
import { Badge, Button, LinkButton } from "./ui";
import { WalletRuleForm, type WalletRulesPayload } from "./wallet-rule-form";

const statusLine = (p: Proposal) =>
  p.status === "PAID"
    ? "Confirmed by the service"
    : p.status === "WAITING"
      ? "Standing instruction"
      : ["PAYING", "RECONCILING"].includes(p.status)
        ? "Payment in progress"
        : "Waiting for your approval";

export function ProposalCard({
  agent,
  onConnectAgent,
  proposal: p,
  wallet: w,
  busy,
  onApprove,
  onDecline,
  onRefresh,
  errorMessage,
  sourceMessages,
  onSource,
}: {
  proposal: Proposal;
  agent?: PublicAgent;
  onConnectAgent?: () => void;
  wallet: PublicWallet;
  busy: boolean;
  onApprove: (rules: WalletRulesPayload) => void;
  onDecline: () => void;
  onRefresh: () => void;
  errorMessage: string;
  sourceMessages: Message[];
  onSource: (id: string) => void;
}) {
  const paying = ["PAYING", "RECONCILING"].includes(p.status),
    waiting = p.status === "WAITING",
    paid = p.status === "PAID",
    open = !paying && !waiting && !paid;
  const after = w.available - p.amount;
  return (
    <section className="ui-card" data-testid="proposal" aria-label="Proposal">
      <div className="ui-card-top">
        <div>
          <div className="ui-card-who">
            {statusLine(p)}
            {paid && (
              <Badge tone="ok">
                <Check size={11} /> Paid
              </Badge>
            )}
            {waiting && <Badge>Watching</Badge>}
            {paying && <Badge tone="warn">Confirming</Badge>}
          </div>
          <h2 className="ui-card-title">{p.title}</h2>
          <p>{w.name}</p>
        </div>
        <div className="ui-price">
          {proposalPrice(p)}
          <small>{proposalPriceLabel(p)}</small>
        </div>
      </div>
      <div className="ui-card-body">
        <p data-testid="proposal-rationale">{p.rationale}</p>
        {p.booking && (
          <p className="ui-note">
            <Clock size={14} />
            {shortDate(p.booking.date + "T12:00:00+04:00")} · {p.booking.time} ·{" "}
            {p.booking.party_size} people · Asia/Dubai
          </p>
        )}
        {p.cancel_effective_at && (
          <p className="ui-note">
            <Check size={14} />
            Renewal disabled. Cancels {shortDate(p.cancel_effective_at)}.
          </p>
        )}
        {p.reason && <p className="ui-note is-danger">{p.reason}</p>}
        {p.comparison && (
          <div data-testid="deal-comparison">
            <h3 className="ui-table-label">Why this deal</h3>
            <table className="ui-table">
              <thead>
                <tr>
                  <th>Pack</th>
                  <th className="is-num">Total</th>
                  <th className="is-num">Unit price</th>
                </tr>
              </thead>
              <tbody>
                {p.comparison.rows.map((row) => {
                  const picked =
                    row.item_id === p.comparison!.selected_item_id &&
                    row.service_id === p.comparison!.selected_service_id;
                  return (
                    <tr
                      key={`${row.service_id}:${row.item_id}`}
                      className={
                        picked ? "is-picked" : row.eligible ? "" : "is-out"
                      }
                    >
                      <td>
                        {row.pack}
                        {picked && <Badge>Chosen</Badge>}
                        {!row.eligible && <Badge>Above limit</Badge>}
                      </td>
                      <td className="is-num">{money(row.amount)}</td>
                      <td className="is-num">
                        {money(row.unit_price)}/{row.unit_label}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="ui-note">
              {p.comparison.scope}. Only current merchant-quoted totals affect
              payment.
            </p>
          </div>
        )}
        {!!sourceMessages.length && (
          <p className="ui-note" data-testid="source-links">
            From {sourceMessages.length} message
            {sourceMessages.length > 1 ? "s" : ""}:
            {sourceMessages.map((message) => (
              <LinkButton key={message.id} onClick={() => onSource(message.id)}>
                {message.subject}
              </LinkButton>
            ))}
          </p>
        )}
        {p.capture_id && (
          <p className="ui-note">
            PayPal sandbox capture{" "}
            <span className="ui-mono">{p.capture_id}</span>
          </p>
        )}
        {agent && !agent.email && (
          <p className="ui-note">
            {agent.name} has no address yet.
            {onConnectAgent && (
              <LinkButton onClick={onConnectAgent} disabled={busy}>
                Create address
              </LinkButton>
            )}
          </p>
        )}
      </div>
      {open && (
        <WalletRuleForm
          errorMessage={errorMessage}
          key={`${p.id}:${w.revision}`}
          wallet={w}
          busy={busy}
          requirePayment
          buttonLabel={
            p.kind === "condition"
              ? "Approve price rule"
              : !w.connected
                ? "Approve and connect PayPal"
                : `Approve ${money(p.amount)}`
          }
          context={
            <>
              Pays from the {w.name} wallet: {money(w.available)} left this{" "}
              {w.period}
              {p.kind !== "condition" && after >= 0
                ? `, ${money(after)} after`
                : ""}
              {(w.reserved > 0 || w.prior_reserved > 0) && (
                <small>
                  {w.reserved > 0 ? `${money(w.reserved)} reserved. ` : ""}
                  {w.prior_reserved > 0
                    ? `${money(w.prior_reserved)} remains reserved from an earlier period.`
                    : ""}
                </small>
              )}
            </>
          }
          onSave={onApprove}
          onDecline={onDecline}
        />
      )}
      {paying && (
        <div className="ui-card-foot">
          <p className="ui-card-ctx">
            The original payment is reconciled with its original request ID.
          </p>
          <Button disabled={busy} onClick={onRefresh}>
            <RefreshCw size={14} />
            Check payment
          </Button>
        </div>
      )}
      {waiting && (
        <div className="ui-card-foot">
          <p className="ui-card-ctx">
            The exact item is watched until{" "}
            {p.condition_expires
              ? shortDate(p.condition_expires)
              : "the chosen expiry"}
            . The rule can buy once.
          </p>
        </div>
      )}
      {paid && (
        <div className="ui-card-foot">
          <p className="ui-card-ctx">
            Payment verified. The service sends its receipt to{" "}
            {w.email ?? "its dedicated address"}. {money(w.available)} left this{" "}
            {w.period}.
          </p>
        </div>
      )}
    </section>
  );
}
