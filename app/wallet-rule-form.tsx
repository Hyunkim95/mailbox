"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import type { PublicWallet } from "../src/app-model";
import { Button, LinkButton, Segmented } from "./ui";

const modes: { id: PublicWallet["mode"]; label: string }[] = [
  { id: "draft", label: "Draft only" },
  { id: "ask", label: "Ask every time" },
  { id: "auto", label: "Automatic within limits" },
];

export type WalletRulesPayload = {
  revision: number;
  cap: number;
  per_action: number;
  auto_under: number;
  daily_limit: number;
  mode: PublicWallet["mode"];
  period: PublicWallet["period"];
  timezone: string;
  expires_at: string;
};
function dubaiDate(iso: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  return ["year", "month", "day"]
    .map((name) => parts.find((p) => p.type === name)!.value)
    .join("-");
}
export function WalletRuleForm({
  wallet,
  busy,
  buttonLabel,
  onSave,
  onDecline,
  requirePayment = false,
  errorMessage,
  context,
}: {
  wallet: PublicWallet;
  busy: boolean;
  buttonLabel: string;
  onSave: (rules: WalletRulesPayload) => void;
  onDecline?: () => void;
  requirePayment?: boolean;
  errorMessage?: string;
  /** Shown beside the approve button: what this approval pays from. */
  context?: ReactNode;
}) {
  // An approval can never go through as "draft", so it starts on "ask":
  // the approve button works at once and the owner is still asked each time.
  const [mode, setMode] = useState<PublicWallet["mode"]>(
      requirePayment && wallet.mode === "draft" ? "ask" : wallet.mode,
    ),
    [showLimits, setShowLimits] = useState(false),
    [cap, setCap] = useState((wallet.cap / 100).toFixed(2)),
    [perAction, setPerAction] = useState((wallet.per_action / 100).toFixed(2)),
    [auto, setAuto] = useState((wallet.auto_under / 100).toFixed(2)),
    [daily, setDaily] = useState(String(wallet.daily_limit)),
    [period, setPeriod] = useState(
      wallet.pending_reset?.period ?? wallet.period,
    ),
    [timezone, setTimezone] = useState(
      wallet.pending_reset?.timezone ?? wallet.timezone,
    ),
    [expiry, setExpiry] = useState(dubaiDate(wallet.expires_at));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      revision: wallet.revision,
      cap: Math.round(Number(cap) * 100),
      per_action: Math.round(Number(perAction) * 100),
      auto_under: Math.round(Number(auto) * 100),
      daily_limit: Number(daily),
      mode,
      period,
      timezone,
      expires_at: new Date(`${expiry}T23:59:59+04:00`).toISOString(),
    });
  };
  const fields = (
    <>
      <label>
        Wallet cap, USD
        <input
          required
          type="number"
          step=".01"
          min="0"
          value={cap}
          onChange={(e) => setCap(e.target.value)}
        />
      </label>
      <label>
        Per action, USD
        <input
          required
          type="number"
          step=".01"
          min=".01"
          value={perAction}
          onChange={(e) => setPerAction(e.target.value)}
        />
      </label>
      {mode === "auto" && (
        <label>
          Automatic up to, USD
          <input
            required
            type="number"
            step=".01"
            min="0"
            value={auto}
            onChange={(e) => setAuto(e.target.value)}
          />
        </label>
      )}
      <label>
        Daily action limit
        <input
          required
          type="number"
          min="1"
          max="100"
          step="1"
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
        />
      </label>
      <label>
        Budget resets
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as PublicWallet["period"])}
        >
          <option value="week">Every week</option>
          <option value="month">Every month</option>
        </select>
      </label>
      <label>
        Budget timezone
        <input
          required
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          list="wallet-timezones"
        />
        <datalist id="wallet-timezones">
          <option value="Asia/Dubai" />
          <option value="UTC" />
          <option value="Europe/London" />
          <option value="America/New_York" />
        </datalist>
      </label>
      <label>
        Permission expires, Dubai date
        <input
          required
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
        />
      </label>
    </>
  );
  if (requirePayment)
    return (
      <form onSubmit={submit}>
        <div className="ui-card-foot">
          <p className="ui-card-ctx">{context}</p>
          {onDecline && (
            <Button variant="ghost" onClick={onDecline} disabled={busy}>
              Decline
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={busy || mode === "draft"}
          >
            {buttonLabel}
          </Button>
        </div>
        <div className="ui-card-foot">
          <p className="ui-card-ctx">
            Payment permission
            <small>
              {mode === "draft"
                ? "Draft only cannot pay. Choose another permission to approve."
                : mode === "ask"
                  ? "You approve every payment to this service."
                  : "Pays without asking, inside the limits you set."}
            </small>
          </p>
          <Segmented
            label="Payment permission"
            options={modes}
            value={mode}
            onChange={setMode}
            disabled={busy}
          />
          <LinkButton
            aria-expanded={showLimits}
            onClick={() => setShowLimits((open) => !open)}
          >
            {showLimits ? "Hide limits" : "Edit limits"}
          </LinkButton>
          {showLimits && <div className="ui-fields">{fields}</div>}
          {showLimits && wallet.spent + wallet.reserved > 0 && (
            <p className="ui-note">
              Reset schedule changes start at the next existing budget boundary.
            </p>
          )}
          {wallet.pending_reset && (
            <p className="ui-note">
              The new reset schedule is saved for the next boundary.
            </p>
          )}
          {errorMessage && (
            <p className="ui-note is-danger" role="alert">
              {errorMessage}
            </p>
          )}
        </div>
      </form>
    );
  return (
    <form className="ui-form" onSubmit={submit}>
      <div className="ui-toolbar">
        <span>Payment permission</span>
        <Segmented
          label="Payment permission"
          options={modes}
          value={mode}
          onChange={setMode}
          disabled={busy}
        />
      </div>
      <div className="ui-fields">{fields}</div>
      {wallet.spent + wallet.reserved > 0 && (
        <p className="ui-note">
          Reset schedule changes start at the next existing budget boundary.
        </p>
      )}
      {wallet.pending_reset && (
        <p className="ui-note">
          The new reset schedule is saved for the next boundary.
        </p>
      )}
      {errorMessage && (
        <p className="ui-note is-danger" role="alert">
          {errorMessage}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        className="is-wide"
        busy={busy}
        disabled={busy}
      >
        {buttonLabel}
      </Button>
    </form>
  );
}
