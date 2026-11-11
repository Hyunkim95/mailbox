"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import {
  AgStudioAiModule,
  createAiHarness,
  directLlmRunner,
  studioTheme,
  type AgAiChatSession,
  type AgAiHarness,
  type AgReportState,
  type AgStudioApi,
} from "ag-studio";
import { ArrowUp } from "lucide-react";
import type { AppState, PublicAgent } from "../src/app-model";
import {
  dashboardData,
  dashboardNiches,
  defaultDashboard,
  type DashboardNiche,
} from "../src/dashboard-data";
import { studioAdapter } from "./studio-adapter";
import { Button, LinkButton } from "./ui";

/** The embedded studio takes literal values, so read them from the design tokens. */
function studioThemeFromTokens() {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return studioTheme.withParams({
    backgroundColor: token("--bg"),
    textColor: token("--ink"),
    fontFamily: `${token("--font-geist")}, system-ui, sans-serif`,
    borderColor: token("--line-strong"),
    studioMinWidth: 0,
    studioCanvasMinWidth: 280,
    studioMinHeight: 520,
    studioWidgetBackgroundColor: token("--surface"),
    studioWidgetTitleFontSize: 15,
    studioWidgetTitleFontWeight: 600,
    chartPaletteFills1Color: token("--chart-1"),
    chartPaletteFills2Color: token("--chart-2"),
  });
}
export default function NicheDashboard({
  state,
  agent,
}: {
  state: AppState;
  agent?: PublicAgent;
}) {
  const [niche, setNiche] = useState<DashboardNiche>(
      agent ? "all" : "groceries",
    ),
    [initial, setInitial] = useState<AgReportState | null>(null),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setInitial(null);
    setError("");
    void fetch(
      agent ? `/api/studio?agent_id=${agent.id}` : `/api/studio?niche=${niche}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not open this dashboard.");
        return r.json();
      })
      .then((data) => {
        setInitial(
          data.layout ??
            defaultDashboard(
              state.wallets.some(
                (w) => niche === "all" || w.category === niche,
              ),
            ),
        );
        setDirty(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [niche, agent?.id]);
  return (
    <section className="ui-col ui-wide">
      {!agent && (
        <div className="ui-toolbar">
          <h1 className="ui-title">Dashboards</h1>
          <label>
            Niche{" "}
            <select
              value={niche}
              onChange={(e) => {
                if (
                  dirty &&
                  !confirm("Switch niches and discard unsaved layout changes?")
                )
                  return;
                setNiche(e.target.value as DashboardNiche);
              }}
            >
              {dashboardNiches.map((n) => (
                <option key={n} value={n}>
                  {n === "all"
                    ? "All niches"
                    : n[0]!.toUpperCase() + n.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="ui-note is-danger">
          {error}
        </p>
      )}
      {initial ? (
        <Canvas
          key={agent?.id ?? niche}
          {...(agent ? { agent_id: agent.id } : {})}
          state={state}
          niche={niche}
          initial={initial}
          dirty={dirty}
          onDirty={setDirty}
        />
      ) : (
        !error && (
          <p role="status" className="ui-note">
            Opening your saved dashboard
          </p>
        )
      )}
    </section>
  );
}
function Canvas({
  agent_id,
  state,
  niche,
  initial,
  dirty,
  onDirty,
}: {
  state: AppState;
  agent_id?: string;
  niche: DashboardNiche;
  initial: AgReportState;
  dirty: boolean;
  onDirty: (value: boolean) => void;
}) {
  const api = useRef<AgStudioApi | null>(null),
    harness = useRef<AgAiHarness | null>(null),
    session = useRef<AgAiChatSession | null>(null);
  const [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [feedback, setFeedback] = useState(""),
    [error, setError] = useState(""),
    [edit, setEdit] = useState(false),
    [ready, setReady] = useState(false);
  const data = useMemo(() => dashboardData(state, niche), [state, niche]);
  const theme = useMemo(studioThemeFromTokens, []);
  useEffect(
    () => () => {
      session.current?.cancel();
      session.current?.close();
      harness.current?.dispose?.();
    },
    [],
  );
  const onReady = useCallback(
    ({ api: studio }: { api: AgStudioApi }) => {
      api.current = studio;
      const tools = studio.getAiTools();
      harness.current = createAiHarness(studio, () => ({
        primary: "dashboard",
        agents: [
          directLlmRunner({
            id: "dashboard",
            name: "Your dashboard designer",
            maxTurns: 10,
            adapter: studioAdapter,
            instructions: () =>
              "Build or change only this niche dashboard. Inspect schema and page before editing. Keep paid and unconfirmed actions distinct, and wallet periods visible. Never combine budgets or invent savings. Use the actual data fields and existing page. Preserve unrelated widgets unless asked to replace them. Use the requested widget type and size. Finish with a short explanation.",
            tools: () => [
              tools.viewSchema(),
              tools.viewReport(),
              tools.viewPage(),
              tools.viewWidget(),
              tools.executeQuery(),
              tools.addWidget(),
              tools.positionWidget(),
              tools.removeWidget(),
              tools.addPageFilter(),
              tools.removePageFilter(),
              ...[
                "grid",
                "column-chart-grouped",
                "bar-chart-grouped",
                "line-chart",
                "pie-chart",
              ].map((widgetType) => tools.configureWidget({ widgetType })),
            ],
          }),
        ],
      }));
      setReady(true);
      onDirty(false);
    },
    [onDirty],
  );
  async function customize(text = prompt) {
    if (!harness.current || !text.trim() || busy) return;
    setError("");
    setFeedback("");
    setBusy(true);
    try {
      const chat = await harness.current.createThread({ agentId: "dashboard" });
      session.current = chat;
      let began = false;
      const listener = () => {
        if (chat.status === "running") {
          began = true;
          return;
        }
        if (!began) return;
        if (chat.status === "error") {
          const part = chat.messages
            .flatMap((m) => m.parts)
            .find((p) => p.type === "error");
          setError(
            part?.type === "error"
              ? part.message
              : "The dashboard change could not be completed.",
          );
        } else {
          const text = chat.messages
            .filter((m) => m.role === "assistant")
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(" ");
          setFeedback(
            text || "Dashboard updated. Review the layout before saving.",
          );
        }
        setBusy(false);
        chat.removeEventListener("changed", listener);
      };
      chat.addEventListener("changed", listener);
      chat.sendMessage(text.trim());
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not customize this dashboard.",
      );
      setBusy(false);
    }
  }
  async function save() {
    if (!api.current) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "studio_save",
          ...(agent_id ? { agent_id } : {}),
          niche,
          layout: api.current.getState(),
        }),
      });
      if (!r.ok)
        throw new Error(
          "Could not save this layout. Your preview is still open.",
        );
      onDirty(false);
      setFeedback("Dashboard layout saved for this niche.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this layout.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <label className="ui-label" htmlFor="dashboard-prompt">
        Customize this dashboard
      </label>
      <form
        className="ui-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void customize();
        }}
      >
        <input
          id="dashboard-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Show message counts by kind as a bar chart"
          disabled={busy || !state.configuration.model}
        />
        <Button
          type="submit"
          variant="icon"
          aria-label="Customize dashboard"
          busy={busy}
          disabled={
            busy || !ready || !prompt.trim() || !state.configuration.model
          }
        >
          <ArrowUp size={16} />
        </Button>
      </form>
      <p className="ui-note">
        {state.configuration.model
          ? "Changes affect this view only. Review them, then save the layout."
          : "No model is connected, so typed changes will not work here. You can still edit the layout by hand."}
      </p>
      <div className="ui-toolbar">
        <span>
          {busy
            ? "Updating your dashboard"
            : dirty
              ? "Unsaved layout changes"
              : "Saved layout"}
        </span>
        {busy && (
          <LinkButton
            onClick={() => {
              session.current?.cancel();
              setBusy(false);
            }}
          >
            Cancel
          </LinkButton>
        )}
        <LinkButton onClick={() => setEdit(!edit)} disabled={busy}>
          {edit ? "Preview layout" : "Edit layout"}
        </LinkButton>
        <LinkButton
          disabled={busy || !ready}
          onClick={() => {
            api.current?.setState(
              defaultDashboard(
                state.wallets.some(
                  (w) => niche === "all" || w.category === niche,
                ),
              ),
            );
            onDirty(true);
            setFeedback("Default layout restored in preview. Save to keep it.");
          }}
        >
          Restore default
        </LinkButton>
        <Button
          variant={dirty ? "primary" : "default"}
          disabled={busy || saving || !ready || !dirty}
          onClick={() => void save()}
        >
          {saving ? "Saving" : "Save layout"}
        </Button>
      </div>
      {error && (
        <p className="ui-note is-danger" role="alert">
          {error}
        </p>
      )}
      {feedback && (
        <p className="ui-note" role="status">
          {feedback}
        </p>
      )}
      <div className="ui-canvas" data-testid="niche-studio">
        <AgStudioProvider
          modules={[AgStudioAiModule]}
          {...(process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY
            ? { licenseKey: process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY }
            : {})}
        >
          <AgStudio
            style={{ height: "100%", width: "100%" }}
            data={data}
            initialState={initial}
            mode={edit ? "edit" : "view"}
            theme={theme}
            panels={{
              edit: { left: ["data"], right: ["edit"] },
              view: { left: [], right: [] },
            }}
            onStudioReady={onReady}
            onStateUpdated={(event) => {
              if (ready && event.durable) onDirty(true);
            }}
            responsiveLayoutBreakpoints={[
              {
                maxWidth: 650,
                layout: (widgets, layout) => {
                  let y = 0;
                  return widgets.map(({ layout: widget }) => {
                    const next = {
                      ...widget,
                      xTrack: 0,
                      yTrack: y,
                      xSpan: layout.columns,
                    };
                    y += widget.ySpan;
                    return next;
                  });
                },
              },
            ]}
          />
        </AgStudioProvider>
      </div>
      <p className="ui-note">
        Built with AG Studio. Values come from your wallets, proposals and
        messages.
      </p>
    </>
  );
}
