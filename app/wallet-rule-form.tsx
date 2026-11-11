"use client";
import { useState } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import type { PublicWallet } from "../src/app-model";

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
  expanded = false,
  errorMessage,
}: {
  wallet: PublicWallet;
  busy: boolean;
  buttonLabel: string;
  onSave: (rules: WalletRulesPayload) => void;
  onDecline?: () => void;
  requirePayment?: boolean;
  expanded?: boolean;
  errorMessage?: string;
}) {
  const [mode, setMode] = useState(wallet.mode),
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
  return (
    <form
      className="wallet-rule-form"
      onSubmit={(event) => {
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
      }}
    >
      <label>
        Payment permission
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as PublicWallet["mode"])}
        >
          <option value="draft">Draft only</option>
          <option value="ask">Ask every time</option>
          <option value="auto">Automatic within limits</option>
        </select>
      </label>
      <details className="limit-details" open={expanded || undefined}>
        <summary>Review spending limits</summary>
        <div className="wallet-fields">
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
              onChange={(e) =>
                setPeriod(e.target.value as PublicWallet["period"])
              }
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
        </div>
        {wallet.spent + wallet.reserved > 0 && (
          <p className="permission-caption">
            Reset schedule changes start at the next existing budget boundary.
          </p>
        )}
      </details>
      {wallet.pending_reset && (
        <p className="permission-caption">
          The new reset schedule is saved for the next boundary.
        </p>
      )}
      {errorMessage && (
        <p className="inline-error" role="alert">
          {errorMessage}
        </p>
      )}
      <button
        type="submit"
        className="primary full"
        disabled={busy || (requirePayment && mode === "draft")}
      >
        {busy ? (
          <LoaderCircle className="spin" size={17} />
        ) : (
          <>
            {buttonLabel}
            <ArrowRight size={16} />
          </>
        )}
      </button>
      {onDecline && (
        <button
          type="button"
          className="decline-button"
          onClick={onDecline}
          disabled={busy}
        >
          Decline
        </button>
      )}
      {requirePayment && (
        <p className="permission-caption">
          <ShieldCheck size={13} />
          {mode === "draft"
            ? "Choose payment permission to continue."
            : "Your approval covers this exact service and these terms."}
        </p>
      )}
    </form>
  );
}
