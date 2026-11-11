"use client";
import { useState } from "react";
import type { PublicAgent } from "../src/app-model";
import { Button, LinkButton } from "./ui";
import {
  Avatar,
  lookFor,
  lookOptions,
  randomLook,
  type Look,
} from "./ui/avatar";

export function AgentHeader({
  agent,
  index,
  busy,
  onConnect,
  onEdit,
}: {
  agent: PublicAgent;
  index: number;
  busy: boolean;
  onConnect: () => void;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <header className="ui-agent-head">
      <Avatar look={lookFor(agent, index)} large />
      <div>
        <h1>{agent.name}</h1>
        <div className="ui-agent-meta">
          <span>{agent.tags.join(", ") || "Your agent"}</span>
          <span className="ui-quiet">/</span>
          {agent.email ? (
            <>
              <span className="ui-mono">{agent.email}</span>
              <LinkButton
                aria-label={`Copy ${agent.name} address`}
                onClick={() => {
                  void navigator.clipboard.writeText(agent.email!).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </LinkButton>
            </>
          ) : (
            <>
              <span>No address yet</span>
              <LinkButton disabled={busy} onClick={onConnect}>
                Create address
              </LinkButton>
            </>
          )}
          <LinkButton disabled={busy} onClick={onEdit}>
            Edit
          </LinkButton>
        </div>
      </div>
    </header>
  );
}
export function AgentForm({
  initial,
  index,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: PublicAgent;
  /** The agent's position in the list, which sets its default colour. */
  index: number;
  busy: boolean;
  error: string;
  onSubmit: (input: {
    name: string;
    purpose: string;
    tags: string[];
    look: Look;
    request_id: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? ""),
    [purpose, setPurpose] = useState(initial?.purpose ?? ""),
    [look, setLook] = useState<Look>(() =>
      initial ? lookFor(initial, index) : randomLook(),
    ),
    [requestId] = useState(() => crypto.randomUUID());
  const templates = [
    {
      name: "Pantry",
      purpose: "Help with grocery newsletters, deals and household shopping.",
      tag: "groceries",
    },
    {
      name: "Tech Shopping",
      purpose:
        "Find technology products and manage the subscriptions I assign here.",
      tag: "shopping",
    },
    {
      name: "Reel",
      purpose: "Help plan film nights and manage the subscriptions I choose.",
      tag: "entertainment",
    },
  ];
  const [tags, setTags] = useState(initial?.tags ?? []);
  return (
    <form
      className="ui-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          name: name.trim(),
          purpose: purpose.trim(),
          tags,
          look,
          request_id: requestId,
        });
      }}
    >
      <div>
        <h2>{initial ? `Edit ${initial.name}` : "New agent"}</h2>
        <p className="ui-sub">
          Give this agent one job. You decide which services and subscriptions
          belong to it.
        </p>
      </div>
      {!initial && (
        <div className="ui-chips">
          <span className="ui-quiet">Start from</span>
          {templates.map((t) => (
            <LinkButton
              key={t.name}
              onClick={() => {
                setName(t.name);
                setPurpose(t.purpose);
                setTags([t.tag]);
              }}
            >
              {t.name}
            </LinkButton>
          ))}
        </div>
      )}
      <div className="ui-look">
        <Avatar look={look} large />
        <div>
          <Button onClick={() => setLook(randomLook())}>Randomize</Button>
          {(
            [
              ["hair", "Hair"],
              ["eyes", "Eyes"],
              ["mouth", "Mouth"],
              ["color", "Colour"],
            ] as const
          ).map(([part, label]) => (
            <div
              className="ui-swatches"
              role="group"
              aria-label={label}
              key={part}
            >
              <span>{label}</span>
              {Array.from({ length: lookOptions[part] }, (_, option) => (
                <button
                  key={option}
                  type="button"
                  className="ui-swatch"
                  aria-label={`${label} ${option + 1}`}
                  aria-pressed={look[part] === option}
                  onClick={() => setLook({ ...look, [part]: option })}
                >
                  <Avatar look={{ ...look, [part]: option }} />
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <label htmlFor="agent-name">
        Name
        <input
          id="agent-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="Tech Shopping"
          required
        />
      </label>
      <label htmlFor="agent-purpose">
        What should this agent help with?
        <textarea
          id="agent-purpose"
          name="purpose"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
          maxLength={1500}
          rows={3}
          placeholder="Product research, tech purchases and software subscriptions"
          required
        />
      </label>
      {!initial && (
        <p className="ui-note">
          The agent gets its own address through your connected email provider.
          Spending permission is set separately for each service.
        </p>
      )}
      {error && (
        <p className="ui-note is-danger" role="alert">
          {error}
        </p>
      )}
      <div className="ui-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          busy={busy}
          disabled={busy || !name.trim() || !purpose.trim()}
        >
          {initial ? "Save agent" : "Create agent and address"}
        </Button>
      </div>
    </form>
  );
}
