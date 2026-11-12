"use client";
import { useState, type FormEvent } from "react";
import type { PublicAgentAllowance } from "../src/app-model";
import { Button } from "./ui";
import { money } from "./agent-scope";

function localInput(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function AgentAllowancePanel({
  allowance,
  busy,
  onSave,
}: {
  allowance: PublicAgentAllowance | null;
  busy: boolean;
  onSave: (input: {
    limit: number;
    expires_at: string;
    paused: boolean;
    expected_revision: number | null;
  }) => Promise<boolean>;
}) {
  const [limit, setLimit] = useState(
      allowance ? (allowance.limit / 100).toFixed(2) : "",
    ),
    [expiry, setExpiry] = useState(
      localInput(
        allowance?.expires_at ??
          new Date(Date.now() + 30 * 86400000).toISOString(),
      ),
    ),
    [paused, setPaused] = useState(allowance?.paused ?? false),
    [error, setError] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const ok = await onSave({
      limit: Math.round(Number(limit) * 100),
      expires_at: new Date(expiry).toISOString(),
      paused,
      expected_revision: allowance?.revision ?? null,
    });
    if (!ok)
      setError(
        "The allowance could not be saved. Check the current limit and commitments.",
      );
  };
  return (
    <section className="ui-work" aria-label="Agent total allowance">
      {allowance && (
        <>
          <div className="ui-section-head">
            <h2>Total allowance</h2>
            <span className="ui-note">
              {allowance.paused
                ? "New payments paused"
                : allowance.expired
                  ? "Expired"
                  : "Across this agent’s services"}
            </span>
          </div>
          <div className="ui-row is-plain">
            <span>
              <span className="ui-row-title">
                {money(allowance.available)} available of{" "}
                {money(allowance.limit)}
              </span>
              <span className="ui-row-detail">
                {money(allowance.spent)} paid · {money(allowance.reserved)}{" "}
                reserved · expires{" "}
                {new Date(allowance.expires_at).toLocaleString()}
              </span>
            </span>
          </div>
        </>
      )}
      <details className="ui-details">
        <summary>
          {allowance
            ? "Edit total allowance"
            : "Set a total allowance across services"}
        </summary>
        <form className="ui-form" onSubmit={(e) => void save(e)}>
          <div className="ui-fields">
            <label>
              Total limit, USD
              <input
                type="number"
                required
                min="0"
                step=".01"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
            <label>
              Total allowance expiry
              <input
                type="datetime-local"
                required
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </label>
          </div>
          <label className="ui-task-title">
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
            />
            Pause new payments for this agent
          </label>
          <p className="ui-note">
            Counts Pigeon payments across this agent’s services, including ended
            services. Existing service limits and approvals still apply. This is
            not your PayPal balance.
          </p>
          {error && (
            <p className="ui-note is-danger" role="alert">
              {error}
            </p>
          )}
          <div className="ui-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              Save total allowance
            </Button>
          </div>
        </form>
      </details>
    </section>
  );
}
