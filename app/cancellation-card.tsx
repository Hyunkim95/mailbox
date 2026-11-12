"use client";
import { useState } from "react";
import type { CancellationReview } from "../src/app-model";
import { Badge, Button } from "./ui";
import { money, shortDate } from "./agent-scope";

export function CancellationCard({
  review,
  busy,
  onConfirm,
  onDiscard,
}: {
  review: Omit<CancellationReview, "owner">;
  busy: boolean;
  onConfirm: () => Promise<string | null>;
  onDiscard: () => void;
}) {
  const [error, setError] = useState("");
  const draft = review.status === "DRAFT",
    pending = review.entries.filter((e) =>
      ["PENDING", "NEEDS_REVIEW"].includes(e.status),
    ).length;
  return (
    <section className="ui-card" aria-label="Cancellation review">
      <div className="ui-card-top">
        <div>
          <div className="ui-card-who">
            {draft
              ? "Waiting for your confirmation"
              : review.status === "RUNNING"
                ? "Checking merchant outcomes"
                : pending
                  ? `${pending} ${pending === 1 ? "service needs" : "services need"} attention`
                  : "Verified merchant outcomes"}
          </div>
          <h2 className="ui-card-title">
            {draft
              ? review.effective === "immediate"
                ? "End access to these services now?"
                : "Review service end dates"
              : "Cancellation results"}
          </h2>
          <p>
            {draft
              ? `${review.entries.length} supported services assigned to this agent.`
              : "Each service is checked separately. Past payments and documents are retained."}
          </p>
        </div>
      </div>
      <div className="ui-card-body">
        {draft && (
          <p className="ui-note">
            {review.effective === "immediate"
              ? "Access ends immediately after merchant confirmation. This action does not request a refund."
              : "Access remains until each merchant’s verified period end."}{" "}
            Payment permissions and the agent’s address are not changed.
          </p>
        )}
        {draft && review.entries.some((e) => e.renewal_already_disabled) && (
          <p className="ui-note">
            Renewal is already disabled for the marked services. Do not count
            this review as preventing a new renewal charge.
          </p>
        )}
        <div className="ui-rows">
          {review.entries.map((entry) => (
            <div className="ui-row is-plain" key={entry.proposal_id}>
              <span>
                <span className="ui-row-title">
                  {entry.title}
                  <Badge
                    tone={entry.status === "NEEDS_REVIEW" ? "warn" : "neutral"}
                  >
                    {entry.status === "ENDED"
                      ? "Ended"
                      : entry.status === "SCHEDULED"
                        ? "Scheduled"
                        : entry.status === "NEEDS_REVIEW"
                          ? "Needs attention"
                          : "To review"}
                  </Badge>
                </span>
                <span className="ui-row-detail">
                  {entry.reason ??
                    (review.effective === "immediate"
                      ? "End access now"
                      : `End access ${entry.period_end ? shortDate(entry.period_end) : "at period end"}`)}
                </span>
                {entry.effective_at && (
                  <span className="ui-row-detail">
                    Verified effective date: {shortDate(entry.effective_at)}
                  </span>
                )}
                {draft && entry.renewal_already_disabled && (
                  <span className="ui-note">Renewal already disabled</span>
                )}
                {draft &&
                  review.effective === "immediate" &&
                  entry.period_end && (
                    <span className="ui-row-detail">
                      Paid access currently runs until{" "}
                      {shortDate(entry.period_end)}.
                    </span>
                  )}
              </span>
              <span className="ui-row-num">
                {money(entry.amount)}
                <small>previously paid</small>
              </span>
            </div>
          ))}
        </div>
        {review.delivery_pending && (
          <p className="ui-note">
            Merchant outcomes are shown above. Delivery of their confirmation
            emails is still pending.
          </p>
        )}
        {error && (
          <p className="ui-note is-danger" role="alert">
            {error}
          </p>
        )}
      </div>
      {(draft || pending > 0) && (
        <div className="ui-card-foot">
          <p className="ui-card-ctx">
            {draft
              ? "Nothing is cancelled until you confirm."
              : "Retry checks the same approved actions. Completed services are not repeated."}
          </p>
          {draft && (
            <Button variant="ghost" disabled={busy} onClick={onDiscard}>
              Discard review
            </Button>
          )}
          <Button
            variant={
              draft && review.effective === "immediate" ? "danger" : "primary"
            }
            busy={busy}
            disabled={busy}
            onClick={async () => {
              setError("");
              const failure = await onConfirm();
              if (failure) setError(failure);
            }}
          >
            {draft
              ? review.effective === "immediate"
                ? "Confirm and end access"
                : "Confirm end dates"
              : "Check unresolved outcomes"}
          </Button>
        </div>
      )}
    </section>
  );
}
