"use client";
import { useState } from "react";
import { ArrowUpRight, Copy, Mail, Plus, LoaderCircle } from "lucide-react";
import type { AppState, PublicAgent } from "../src/app-model";

export function AgentHome({
  state,
  onOpen,
  onCreate,
  onLoadDemo,
}: {
  state: AppState;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onLoadDemo: () => void;
}) {
  const agents = state.agents ?? [];
  return (
    <section className="agents-home">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Your team, on your terms</div>
          <h1>Your agents.</h1>
          <p>
            Give each agent a purpose and an address. Bring the right
            information to them.
          </p>
        </div>
        <button className="primary" onClick={onCreate}>
          <Plus size={17} />
          Create an agent
        </button>
      </div>
      <p className="agent-intro">
        <Mail size={19} />
        One address can bring an agent emails from many services. You choose how
        broad or focused its job should be.
      </p>
      {agents.length ? (
        <div className="agent-grid">
          {agents.map((agent, index) => {
            const messages = state.messages.filter(
              (m) => m.agent_id === agent.id,
            );
            const flagged = messages.filter((m) => m.facts.suspicious).length;
            const expired = messages.filter(
              (m) =>
                m.kind === "offer" &&
                m.facts.expires &&
                new Date(m.facts.expires) < new Date(),
            ).length;
            const invoices = messages.filter(
              (m) => m.kind === "invoice",
            ).length;
            return (
              <article
                className={`agent-card agent-color-${index % 4}`}
                key={agent.id}
              >
                <div className="agent-card-top">
                  <span className="agent-avatar">
                    {agent.name[0]?.toUpperCase()}
                  </span>
                  <div>
                    <h2>{agent.name}</h2>
                    <small>
                      {agent.tags.join(" · ") || "Your personal agent"}
                    </small>
                  </div>
                </div>
                <div className="agent-card-address">
                  <Mail size={13} />
                  <span>{agent.email ?? "Address ready to create"}</span>
                </div>
                <p className="agent-purpose">{agent.purpose}</p>
                <div className="agent-signal">
                  {flagged
                    ? `${flagged} flagged message${flagged > 1 ? "s" : ""} to inspect`
                    : invoices
                      ? `${invoices} invoice${invoices > 1 ? "s" : ""} to inspect`
                      : expired
                        ? `${expired} expired offer${expired > 1 ? "s" : ""} identified`
                        : messages.length
                          ? "New information from your services"
                          : "Ready for the services you choose"}
                </div>
                <footer>
                  <small>
                    {messages.length} message{messages.length !== 1 ? "s" : ""}
                    {messages.some(
                      (m) =>
                        m.origin === "fixture_preview" ||
                        m.scenario ||
                        m.id.startsWith("fixture:"),
                    )
                      ? " · includes samples"
                      : ""}
                  </small>
                  <button
                    className="agent-open"
                    aria-label={`Open ${agent.name}`}
                    onClick={() => onOpen(agent.id)}
                  >
                    Open agent <ArrowUpRight size={14} />
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-services">
          <Mail size={28} />
          <h3>Create your first agent.</h3>
          <p>
            Give it a job and its own address, then use that address for
            relevant services.
          </p>
          <button className="secondary" onClick={onLoadDemo}>
            Explore sample agents
          </button>
        </div>
      )}
    </section>
  );
}
export function AgentIdentity({
  agent,
  busy,
  onConnect,
  onEdit,
}: {
  agent: PublicAgent;
  busy: boolean;
  onConnect: () => void;
  onEdit: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="agent-identity">
      <div className="agent-identity-main">
        <span className="agent-avatar">{agent.name[0]?.toUpperCase()}</span>
        <div>
          <div className="eyebrow">
            {agent.tags.join(" · ") || "Your agent"}
          </div>
          <h1>{agent.name}</h1>
          <div className="agent-address-line">
            {agent.email ? (
              <>
                <Mail size={14} />
                <span>{agent.email}</span>
                <button
                  aria-label={`Copy ${agent.name} address`}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(agent.email!)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      });
                  }}
                >
                  <Copy size={12} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
            ) : (
              <span>This agent’s address has not been created yet.</span>
            )}
          </div>
        </div>
      </div>
      <div className="agent-identity-actions">
        {!agent.email && (
          <button className="primary" disabled={busy} onClick={onConnect}>
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Mail size={15} />
            )}
            Create address
          </button>
        )}
        <button className="text-button" disabled={busy} onClick={onEdit}>
          Edit agent
        </button>
      </div>
    </section>
  );
}
export function AgentForm({
  initial,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: PublicAgent;
  busy: boolean;
  error: string;
  onSubmit: (input: {
    name: string;
    purpose: string;
    tags: string[];
    request_id: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? ""),
    [purpose, setPurpose] = useState(initial?.purpose ?? ""),
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
      className="agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          name: name.trim(),
          purpose: purpose.trim(),
          tags,
          request_id: requestId,
        });
      }}
    >
      <div className="eyebrow">A name. A purpose. An address.</div>
      <h2>{initial ? `Edit ${initial.name}` : "Create your agent"}</h2>
      <p>
        Choose what this agent helps with. You decide which services and
        subscriptions belong to it.
      </p>
      {!initial && (
        <div className="agent-template-options">
          {templates.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => {
                setName(t.name);
                setPurpose(t.purpose);
                setTags([t.tag]);
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      <label htmlFor="agent-name">
        Name
        <input
          id="agent-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={60}
          placeholder="e.g. Tech Shopping"
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
          placeholder="e.g. Product research, tech purchases and software subscriptions"
          required
        />
      </label>
      {!initial && (
        <p className="permission-caption">
          An address is created through your connected email provider. Spending
          permissions are reviewed separately for each service.
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="agent-form-actions">
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !name.trim() || !purpose.trim()}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : null}
          {initial ? "Save agent" : "Create agent & address"}
        </button>
      </div>
    </form>
  );
}
