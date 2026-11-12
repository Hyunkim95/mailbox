"use client";
import type { ReactNode } from "react";
import { Check, Clock, RefreshCw } from "lucide-react";
import type {
  Message,
  Proposal,
  PublicAgent,
  PublicWallet,
  PublicAgentAllowance,
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
  allowance,
  evidence,
  now,
  onReviewAgain,
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
  allowance?: PublicAgentAllowance | null;
  evidence?: ReactNode;
  now?: string;
  onReviewAgain?: () => void;
}) {
  const paying = ["PAYING", "RECONCILING"].includes(p.status),
    waiting = p.status === "WAITING",
    paid = p.status === "PAID",
    open = !paying && !waiting && !paid;
  const after = w.available - p.amount;
  const quoteExpired =
    open &&
    !["condition", "schedule"].includes(p.kind) &&
    (!p.quote_expires ||
      !(new Date(p.quote_expires) > new Date(now ?? Date.now())));
  const allowanceBlock =
    open && p.kind !== "condition" && p.kind !== "schedule" && allowance
      ? allowance.paused
        ? "New payments for this agent are paused."
        : allowance.expired
          ? "The total allowance expired. Review its expiry before approving."
          : p.amount > allowance.available
            ? "This proposal exceeds the remaining total allowance across this agent’s services."
            : undefined
      : undefined;
  const approvalBlock = quoteExpired
    ? "This price expired. Get a fresh review before approving."
    : allowanceBlock;
  return (
    <section className="ui-card" data-testid="proposal" aria-label="Proposal">
      <div className="ui-card-top">
        <div>
          <div className="ui-card-who">
            {quoteExpired ? "Price expired" : statusLine(p)}
            {paid && (
              <Badge tone="ok">
                <Check size={11} /> Paid
              </Badge>
            )}
            {waiting && (
              <Badge>{p.kind === "schedule" ? "Scheduled" : "Watching"}</Badge>
            )}
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
        {p.monthly_schedule && (
          <div aria-label="Monthly purchase rule" className="ui-monthly-rule">
            <p>
              <strong>
                {p.quantity} × {p.monthly_schedule.item.name}
              </strong>
            </p>
            <p>
              Every month on day {p.monthly_schedule.day_of_month} at{" "}
              {p.monthly_schedule.local_time} · {p.monthly_schedule.timezone}
            </p>
            <p>
              {p.monthly_schedule.price_inclusive ? "Up to" : "Below"}{" "}
              {money(p.monthly_schedule.max_amount_minor)} delivered per order.
              Ask before changing the product, quantity or price boundary.
            </p>
            {p.next_scheduled_at && (
              <p>
                <strong>Next eligible purchase:</strong>{" "}
                {new Date(p.next_scheduled_at).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: p.monthly_schedule.timezone,
                })}
              </p>
            )}
            <p className="ui-note">
              Last reviewed quote: {money(p.amount)}. Each due purchase must fit
              both the rule and your wallet limits.
            </p>
            <p className="ui-note">
              Permission ends{" "}
              {new Date(p.monthly_schedule.expires_at).toLocaleString("en-US", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: p.monthly_schedule.timezone,
              })}
              .{" "}
              {p.monthly_schedule.day_of_month > 28
                ? "Short months use their last day. "
                : ""}
              Each purchase checks current stock, delivered price and payment
              limits.
            </p>
            {p.latest_scheduled_purchase && (
              <p className="ui-note" data-testid="latest-monthly-purchase">
                {p.latest_scheduled_purchase.period}:{" "}
                {p.latest_scheduled_purchase.status === "PAID"
                  ? "Payment verified"
                  : p.latest_scheduled_purchase.status === "RECONCILING" ||
                      p.latest_scheduled_purchase.status === "PAYING"
                    ? "Payment awaiting confirmation"
                    : "Purchase needs review"}{" "}
                · {money(p.latest_scheduled_purchase.amount)}
                {p.latest_scheduled_purchase.capture_id && (
                  <small>
                    PayPal sandbox capture{" "}
                    <span className="ui-mono">
                      {p.latest_scheduled_purchase.capture_id}
                    </span>
                  </small>
                )}
              </p>
            )}
          </div>
        )}
        {p.kind === "schedule" ? (
          <details>
            <summary>Why this rule</summary>
            <p data-testid="proposal-rationale">{p.rationale}</p>
          </details>
        ) : (
          <p data-testid="proposal-rationale">{p.rationale}</p>
        )}
        {p.kind === "schedule" &&
          p.next_scheduled_at &&
          new Date(w.expires_at) <= new Date(p.next_scheduled_at) && (
            <p className="ui-note is-danger" role="alert">
              The wallet permission ends before the next monthly purchase.
              Extend it in Edit limits before approving this rule.
            </p>
          )}
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
        {quoteExpired && (
          <div className="ui-note is-danger" role="alert">
            <p>No payment will be made at this expired price.</p>
            {onReviewAgain && (
              <Button disabled={busy} onClick={onReviewAgain}>
                Get a fresh review
              </Button>
            )}
          </div>
        )}
        {allowanceBlock && (
          <p className="ui-note is-danger" role="alert">
            {allowanceBlock}
          </p>
        )}
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
        {evidence ? (
          <p className="ui-note" data-testid="source-links">
            Sources: {evidence}
          </p>
        ) : (
          !!sourceMessages.length && (
            <p className="ui-note" data-testid="source-links">
              From {sourceMessages.length} message
              {sourceMessages.length > 1 ? "s" : ""}:
              {sourceMessages.map((message) => (
                <LinkButton
                  key={message.id}
                  onClick={() => onSource(message.id)}
                >
                  {message.subject}
                </LinkButton>
              ))}
            </p>
          )
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
          {...(!["condition", "schedule"].includes(p.kind)
            ? { reviewAmount: p.amount }
            : {})}
          errorMessage={errorMessage}
          key={`${p.id}:${w.revision}`}
          wallet={w}
          busy={busy}
          requirePayment
          requireAutomatic={p.kind === "schedule"}
          minimumAutomatic={p.kind === "schedule" ? 1 : 0}
          {...(approvalBlock ? { blockedReason: approvalBlock } : {})}
          buttonLabel={
            p.kind === "schedule"
              ? !w.connected
                ? "Approve monthly rule and connect PayPal"
                : "Approve monthly rule"
              : p.kind === "condition"
                ? "Approve price rule"
                : !w.connected
                  ? "Approve and connect PayPal"
                  : `Approve ${money(p.amount)}`
          }
          context={
            <>
              Pays from the {w.name} wallet: {money(w.available)} left this{" "}
              {w.period}
              {p.kind !== "condition" && p.kind !== "schedule" && after >= 0
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
          {p.kind === "schedule" ? (
            <>
              <p className="ui-card-ctx">
                One order per eligible month. Any order already dispatched
                remains in your payment records.
              </p>
              <Button variant="ghost" disabled={busy} onClick={onDecline}>
                Stop monthly purchases
              </Button>
            </>
          ) : (
            <p className="ui-card-ctx">
              The exact item is watched until{" "}
              {p.condition_expires
                ? shortDate(p.condition_expires)
                : "the chosen expiry"}
              . The rule can buy once.
            </p>
          )}
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
