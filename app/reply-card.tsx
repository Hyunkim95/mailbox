"use client";
import { useState } from "react";
import type { PublicAgent } from "../src/app-model";
import { Button, LinkButton } from "./ui";

export type ReplyDraft = {
  message_id: string;
  service_id: string;
  to_name: string;
  subject: string;
  body: string;
};

/** A drafted reply. Nothing is sent until the owner approves it here. */
export function ReplyCard({
  draft,
  agent,
  busy,
  onSend,
  onDiscard,
  onConnectAgent,
}: {
  draft: ReplyDraft;
  agent: PublicAgent;
  busy: boolean;
  /** Resolves to an error message, or null once the reply is sent. */
  onSend: (body: string, requestId: string) => Promise<string | null>;
  onDiscard: () => void;
  onConnectAgent: () => void;
}) {
  const [body, setBody] = useState(draft.body),
    [requestId] = useState(() => crypto.randomUUID()),
    [sending, setSending] = useState(false),
    [sent, setSent] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="ui-card" aria-label="Reply draft">
      <div className="ui-card-top">
        <div>
          <div className="ui-card-who">
            {sent ? "Sent" : "Waiting for your approval"}
          </div>
          <h2 className="ui-card-title">Reply to {draft.to_name}</h2>
          <p>
            In reply to “{draft.subject}”
            {agent.email && (
              <>
                {" "}
                · from <span className="ui-mono">{agent.email}</span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="ui-card-body">
        <label className="sr-only" htmlFor="reply-body">
          Reply to {draft.to_name}
        </label>
        <textarea
          id="reply-body"
          className="ui-textarea"
          value={body}
          maxLength={4000}
          rows={7}
          readOnly={sent}
          onChange={(event) => setBody(event.target.value)}
        />
        {!sent && agent.email && (
          <p className="ui-note">
            You can edit the draft. It is sent from {agent.name}’s address, so
            replies come back to {agent.name}.
          </p>
        )}
        {!sent && !agent.email && (
          <p className="ui-note">
            {agent.name} needs its own address before it can send this.
            <LinkButton onClick={onConnectAgent} disabled={busy}>
              Create address
            </LinkButton>
          </p>
        )}
        {error && (
          <p className="ui-note is-danger" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="ui-card-foot">
        {sent ? (
          <p className="ui-card-ctx">
            Sent to {draft.to_name}. Their answer will arrive in {agent.name}’s
            inbox.
          </p>
        ) : (
          <>
            <p className="ui-card-ctx">
              Sends 1 message to {draft.to_name}. No payment is made.
            </p>
            <Button variant="ghost" onClick={onDiscard} disabled={sending}>
              Discard
            </Button>
            <Button
              variant="primary"
              busy={sending}
              disabled={busy || sending || !body.trim() || !agent.email}
              onClick={async () => {
                setSending(true);
                setError("");
                const failure = await onSend(body, requestId);
                setSending(false);
                if (failure) setError(failure);
                else setSent(true);
              }}
            >
              Send reply
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
