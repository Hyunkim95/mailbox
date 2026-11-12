"use client";
import { useRef } from "react";
import { CheckCircle2, CircleAlert, FileText, Upload } from "lucide-react";
import type { AgentTask, AppState } from "../src/app-model";
import { Badge, Button, LinkButton, SectionHead } from "./ui";

export function EvidenceLinks({
  ids,
  state,
  onOpen,
}: {
  ids: string[];
  state: AppState;
  onOpen: (id: string) => void;
}) {
  return (
    <span className="ui-evidence-links">
      {[...new Set(ids)].map((id) => {
        const message = state.messages.find((m) => m.id === id),
          doc = state.documents?.find((d) => d.id === id);
        return message || doc ? (
          <LinkButton key={id} onClick={() => onOpen(id)}>
            {doc?.filename ?? message!.subject}
          </LinkButton>
        ) : null;
      })}
    </span>
  );
}
export function TaskChecklist({
  tasks,
  state,
  onOpen,
}: {
  tasks: AgentTask[];
  state: AppState;
  onOpen: (id: string) => void;
}) {
  if (!tasks.length) return null;
  const ready = tasks.filter((t) => t.status === "ready").length,
    blocked = tasks.filter((t) => t.status === "blocked").length;
  return (
    <section className="ui-work" aria-label="Checklist">
      <div className="ui-section-head">
        <h2 className="ui-work-heading">
          {ready
            ? `${ready} ready`
            : blocked
              ? `${blocked} ${blocked === 1 ? "thing needs" : "things need"} you`
              : "Work in progress"}
          {ready && blocked
            ? `, ${blocked} ${blocked === 1 ? "needs" : "need"} you`
            : ready && tasks.length > ready
              ? `, ${tasks.length - ready} in progress`
              : ""}
        </h2>
        <span className="ui-note">Saved checklist</span>
      </div>
      <div className="ui-rows">
        {tasks.map((task) => (
          <div className="ui-task" key={task.id}>
            <span
              className={`ui-task-icon ${task.status === "ready" ? "is-ready" : ""}`}
            >
              {task.status === "ready" ? (
                <CheckCircle2 size={19} />
              ) : (
                <CircleAlert size={19} />
              )}
            </span>
            <div>
              <div className="ui-task-title">
                {task.text}
                <Badge tone={task.status === "blocked" ? "warn" : "neutral"}>
                  {task.status === "ready"
                    ? "Ready"
                    : task.status === "blocked"
                      ? "Needs you"
                      : "In progress"}
                </Badge>
              </div>
              <p className="ui-note">
                {task.note.length > 170
                  ? `${task.note.slice(0, 170).replace(/\s+\S*$/, "")}…`
                  : task.note}
              </p>
              {task.note.length > 170 && (
                <details className="ui-details">
                  <summary>Details</summary>
                  <p className="ui-note">{task.note}</p>
                </details>
              )}
              <EvidenceLinks ids={task.sources} state={state} onOpen={onOpen} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
export function DocumentsPanel({
  state,
  busy,
  onUpload,
  onOpen,
}: {
  state: AppState;
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="ui-col">
      <SectionHead title="Documents" />
      <p className="ui-sub">
        Supporting files for this agent. Text PDFs and text files can be
        searched and cited.
      </p>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label="Choose a document"
        accept=".pdf,.txt,.csv,.md,.json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onUpload(file);
          e.target.value = "";
        }}
      />
      <Button
        variant="primary"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Upload size={15} /> Add document
      </Button>
      <div className="ui-rows is-spaced">
        {state.documents?.map((doc) => (
          <button
            className="ui-row"
            key={doc.id}
            onClick={() => onOpen(doc.id)}
          >
            <FileText size={19} />
            <span>
              <span className="ui-row-title">{doc.filename}</span>
              <span className="ui-row-detail">
                {doc.status === "readable" ? "Ready to search" : doc.limitation}
                {doc.origin === "fixture_preview" ? " · Sample document" : ""}
              </span>
            </span>
            <Badge tone={doc.status === "readable" ? "neutral" : "warn"}>
              {doc.status === "readable" ? "Readable" : "Needs attention"}
            </Badge>
          </button>
        ))}
        {!state.documents?.length && (
          <div className="ui-empty">
            <h3>No supporting files yet</h3>
            <p>
              Add a document here, or receive an attachment in this agent’s
              inbox.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
