"use client";
import dynamic from "next/dynamic";
import { MarketResults } from "./market-results";
import { AgentHome, AgentIdentity, AgentForm } from "./agent-home";
import type { MarketResult } from "../src/market";
const NicheDashboard = dynamic(() => import("./niche-dashboard"), {
  ssr: false,
  loading: () => <p>Opening your dashboard…</p>,
});
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Mail,
  Wallet as WalletIcon,
  LayoutGrid,
  BarChart3,
  Clock,
  Check,
  ChevronRight,
  X,
  Search,
  Play,
  Coffee,
  Utensils,
  PawPrint,
  ShieldCheck,
  ArrowUp,
  LoaderCircle,
  Pause,
  MoreHorizontal,
  RefreshCw,
  ExternalLink,
  KeyRound,
  LogOut,
  Code2,
  FileText,
} from "lucide-react";
import type {
  AppState,
  PublicWallet,
  Proposal,
  Message,
  PublicAgent,
} from "../src/app-model";
import { WalletRuleForm } from "./wallet-rule-form";

type Option = {
  id: string;
  name: string;
  kind: string;
  amount: number;
  item_id: string;
  terms: string;
  category: string;
};
type Result = {
  type: "options" | "answer" | "proposal" | "market";
  market?: MarketResult;
  title?: string;
  options?: Option[];
  answer?: string;
  sources?: string[];
  proposal?: Proposal;
  engine?: string;
};
const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );
const date = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Dubai",
  });
const icons = {
  entertainment: Play,
  groceries: Coffee,
  dining: Utensils,
  pets: PawPrint,
};
const agentSections = [
  { id: "services", label: "Overview", icon: LayoutGrid },
  { id: "messages", label: "Inbox", icon: Mail },
  { id: "dashboards", label: "Dashboard", icon: BarChart3 },
  { id: "connections", label: "Services", icon: Mail },
  { id: "activity", label: "Activity", icon: WalletIcon },
];
const samples = [
  {
    id: "film",
    text: "I want to watch The Lantern Coast",
    label: "Watch a film",
    icon: Play,
  },
  {
    id: "coffee",
    text: "Find me the cheapest coffee deal this week",
    label: "Find a coffee deal",
    icon: Coffee,
  },
  {
    id: "dining",
    text: "Book a restaurant near the marina for Friday at 7 pm for two people",
    label: "Book dinner",
    icon: Utensils,
  },
  {
    id: "pets",
    text: "Reorder the 3 kg adult dog food when its total price drops below $30",
    label: "Restock dog food",
    icon: PawPrint,
  },
];
function ServiceMark({ category }: { category: string }) {
  const Icon = icons[category as keyof typeof icons] ?? Mail;
  return (
    <span className={`service-mark ${category}`}>
      <Icon size={19} />
    </span>
  );
}

export default function Mailbox() {
  const [workspaceState, setState] = useState<AppState | null>(null),
    [needsLogin, setNeedsLogin] = useState(false),
    [loginKey, setLoginKey] = useState("");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [navigationReady, setNavigationReady] = useState(false);
  const [agentForm, setAgentForm] = useState<"create" | PublicAgent | null>(
    null,
  );
  const activeAgent = workspaceState?.agents?.find(
    (agent) => agent.id === activeAgentId,
  );
  const actorRef = useRef<string | null>(null);
  useEffect(() => {
    actorRef.current = activeAgentId;
  }, [activeAgentId]);
  const state: AppState | null =
    workspaceState && activeAgent
      ? {
          ...workspaceState,
          wallets: workspaceState.wallets.filter(
            (wallet) =>
              wallet.agent_id === activeAgent.id ||
              (!wallet.agent_id && activeAgent.template === wallet.category),
          ),
          proposals: workspaceState.proposals.filter(
            (proposal) =>
              proposal.agent_id === activeAgent.id ||
              (!proposal.agent_id &&
                workspaceState.wallets.some(
                  (wallet) =>
                    wallet.id === proposal.wallet_id &&
                    (wallet.agent_id === activeAgent.id ||
                      (!wallet.agent_id &&
                        activeAgent.template === wallet.category)),
                )),
          ),
          messages: workspaceState.messages.filter(
            (message) => message.agent_id === activeAgent.id,
          ),
          audit: workspaceState.audit.filter(
            (event) =>
              !event.service_id ||
              workspaceState.wallets.some(
                (wallet) =>
                  wallet.service_id === event.service_id &&
                  (wallet.agent_id === activeAgent.id ||
                    (!wallet.agent_id &&
                      activeAgent.template === wallet.category)),
              ),
          ),
        }
      : workspaceState;
  function openAgent(id: string, section = "services") {
    setActiveAgentId(id);
    setExpandedAgents((current) => new Set([...current, id]));
    setView(section);
    setResult(null);
    setAsk("");
    setSelectedService(null);
    setError("");
    setNotice("");
  }
  const [view, setView] = useState("agents"),
    [ask, setAsk] = useState(""),
    [searchScope, setSearchScope] = useState("services"),
    [result, setResult] = useState<Result | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState(""),
    [failedAction, setFailedAction] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [selectedService, setSelectedService] = useState<string | null>(null),
    [openMessage, setOpenMessage] = useState<Message | null>(null),
    [selectedOption, setSelectedOption] = useState("coast-screen"),
    [showSdk, setShowSdk] = useState(false),
    [editingWallet, setEditingWallet] = useState<string | null>(null);
  async function refresh() {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (response.status === 401) {
      setNeedsLogin(true);
      return;
    }
    if (response.ok) {
      setState(await response.json());
      setNeedsLogin(false);
    }
  }
  useEffect(() => {
    void refresh();
    const query = new URLSearchParams(location.search);
    if (query.get("agent")) {
      const id = query.get("agent")!;
      setActiveAgentId(id);
      setExpandedAgents(new Set([id]));
      setView(
        agentSections.some((section) => section.id === query.get("view"))
          ? query.get("view")!
          : "services",
      );
    }
    if (query.get("error")) setError(query.get("error")!);
    if (query.get("result"))
      setNotice(
        query.get("result") === "paid"
          ? "Payment confirmed. Your service is ready."
          : query.get("result") === "armed"
            ? "Price rule armed. It can act only within your saved limits."
            : query.get("result") === "consent-canceled"
              ? "PayPal connection canceled. Nothing was charged."
              : "Payment confirmation is still in progress.",
      );
    query.delete("error");
    query.delete("result");
    history.replaceState(
      {},
      "",
      `${location.pathname}${query.size ? `?${query}` : ""}`,
    );
    setNavigationReady(true);
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!navigationReady) return;
    const url = new URL(location.href);
    if (activeAgentId) {
      url.searchParams.set("agent", activeAgentId);
      url.searchParams.set("view", view);
    } else {
      url.searchParams.delete("agent");
      url.searchParams.delete("view");
    }
    history.replaceState({}, "", url);
  }, [activeAgentId, view, navigationReady]);
  async function command(payload: Record<string, unknown>, label = "request") {
    const requestedActor = activeAgentId;
    if (
      activeAgentId &&
      [
        "ask",
        "propose",
        "market_search",
        "studio_turn",
        "studio_save",
      ].includes(String(payload.action)) &&
      !payload.agent_id
    )
      payload = { ...payload, agent_id: activeAgentId };
    setBusy(label);
    setError("");
    setFailedAction(null);
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.message ?? "This request could not be completed.");
      const sameActor = !requestedActor || actorRef.current === requestedActor;
      if (data.type === "redirect" && sameActor) {
        location.assign(data.url);
        return data;
      }
      if (data.signedIn) {
        setActiveAgentId(null);
        setView("agents");
        setResult(null);
      }
      if (data.reset) {
        setResult(null);
        setSelectedService(null);
        setActiveAgentId(null);
        setView("agents");
        setNotice(
          "Fresh workspace opened. Old wallets are paused and past sandbox payments remain recorded.",
        );
      }
      if (data.type && sameActor) {
        setResult(
          data.type === "market" ? { type: "market", market: data } : data,
        );
        if (data.type === "options")
          setSelectedOption(
            data.options.some((o: Option) => o.id === "coast-screen")
              ? "coast-screen"
              : (data.options[0]?.id ?? ""),
          );
      }
      await refresh();
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
      setFailedAction(String(payload.action));
      try {
        await refresh();
      } catch {}
      return null;
    } finally {
      setBusy(null);
    }
  }
  async function submitAsk(
    event?: FormEvent,
    example?: (typeof samples)[number],
  ) {
    event?.preventDefault();
    const text = example?.text ?? ask.trim();
    if (!text) return;
    setAsk(text);
    if (example) setSearchScope("services");
    setView("services");
    await command(
      {
        action: !example && searchScope === "market" ? "market_search" : "ask",
        text,
        ...(example ? { example: example.id } : {}),
      },
      "ask",
    );
  }
  async function browse() {
    setBusy("browse");
    setError("");
    try {
      const r = await fetch("/api/services");
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? "Services are unavailable.");
      setResult({
        type: "options",
        title: "Explore the fixture services",
        options: d.services.map(
          (s: {
            id: string;
            name: string;
            kind: string;
            category: string;
            items: { id: string; amount_minor: number; terms: string }[];
          }) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            category: s.category,
            item_id: s.items[0]!.id,
            amount: s.items[0]!.amount_minor,
            terms: s.items[0]!.terms,
          }),
        ),
      });
      setSelectedOption("coast-screen");
      setView("services");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Services are unavailable.");
    } finally {
      setBusy(null);
    }
  }
  const newest = state?.proposals.find((p) =>
    ["NEEDS_APPROVAL", "APPROVED", "WAITING", "PAYING", "RECONCILING"].includes(
      p.status,
    ),
  );
  const priorityProposal = state?.proposals.find((p) =>
    ["PAYING", "RECONCILING"].includes(p.status),
  );
  const activeProposal =
    priorityProposal ??
    (result?.type === "proposal"
      ? (state?.proposals.find((p) => p.id === result.proposal?.id) ??
        result.proposal)
      : newest);
  const proposalWallet = state?.wallets.find(
    (w) => w.id === activeProposal?.wallet_id,
  );
  const serviceWallet = state?.wallets.find(
    (w) => w.service_id === selectedService,
  );
  const filteredMessages =
    state?.messages.filter(
      (m) => !selectedService || m.service_id === selectedService,
    ) ?? [];
  const inFlight =
    state?.proposals.filter((p) => ["PAYING", "RECONCILING"].includes(p.status))
      .length ?? 0;

  if (needsLogin)
    return (
      <div className="login-page">
        <div className="login-brand">
          <span className="brand-symbol">
            <Mail size={22} />
          </span>
          Mailbox
        </div>
        <main className="login-card">
          <div className="eyebrow">Private sandbox demo</div>
          <h1>
            Your services.
            <br />
            Your terms.
          </h1>
          <p>
            An address for the messages.
            <br />A wallet for the decisions.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await command({ action: "login", key: loginKey }, "login");
            }}
          >
            <label htmlFor="demo-key">Demo access key</label>
            <div className="login-input">
              <KeyRound size={17} />
              <input
                id="demo-key"
                type="password"
                value={loginKey}
                onChange={(e) => setLoginKey(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            {error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary full" disabled={!!busy}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <>
                  Open Mailbox <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <small>Invented services. PayPal sandbox. No real money.</small>
        </main>
      </div>
    );
  if (!state || !workspaceState)
    return (
      <div className="loading-page">
        <Mail size={24} />
        <p>Opening your services…</p>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-symbol">
            <Mail size={20} />
          </span>
          Mailbox<span className="brand-period">.</span>
        </a>
        <div className="sidebar-navigation">
          <span className="sidebar-label">Your space</span>
          <nav aria-label="Your space">
            {[
              { id: "agents", label: "Your agents", icon: LayoutGrid },
              { id: "messages", label: "All messages", icon: Mail },
              { id: "inbox", label: "Before Mailbox", icon: FileText },
            ].map((item) => (
              <button
                key={item.id}
                className={
                  !activeAgentId && view === item.id
                    ? "nav-item active"
                    : "nav-item"
                }
                onClick={() => {
                  setView(item.id);
                  setActiveAgentId(null);
                  setResult(null);
                  setSelectedService(null);
                }}
              >
                <item.icon size={18} />
                {item.label}
                {item.id === "messages" &&
                  workspaceState.messages.length > 0 && (
                    <span className="nav-count">
                      {workspaceState.messages.length}
                    </span>
                  )}
              </button>
            ))}
          </nav>
          <div className="sidebar-agents">
            <span className="sidebar-label">Your agents</span>
            {workspaceState.agents.map((agent) => (
              <section className="sidebar-agent" key={agent.id}>
                <div
                  className={`sidebar-agent-heading ${activeAgentId === agent.id ? "active" : ""}`}
                >
                  <button
                    className="sidebar-agent-open"
                    onClick={() => openAgent(agent.id)}
                    aria-label={`Open ${agent.name} workspace`}
                  >
                    <span>{agent.name[0]?.toUpperCase()}</span>
                    <strong>{agent.name}</strong>
                    <small>
                      {
                        workspaceState.messages.filter(
                          (message) => message.agent_id === agent.id,
                        ).length
                      }
                    </small>
                  </button>
                  <button
                    className="sidebar-agent-toggle"
                    aria-label={`${expandedAgents.has(agent.id) ? "Collapse" : "Expand"} ${agent.name} sections`}
                    aria-expanded={expandedAgents.has(agent.id)}
                    aria-controls={`agent-sections-${agent.id}`}
                    onClick={() =>
                      setExpandedAgents((current) => {
                        const next = new Set(current);
                        if (next.has(agent.id)) next.delete(agent.id);
                        else next.add(agent.id);
                        return next;
                      })
                    }
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
                <nav
                  id={`agent-sections-${agent.id}`}
                  aria-label={`${agent.name} sections`}
                  hidden={!expandedAgents.has(agent.id)}
                >
                  {agentSections.map((section) => (
                    <button
                      key={section.id}
                      className="sidebar-agent-section"
                      aria-current={
                        activeAgentId === agent.id && view === section.id
                          ? "page"
                          : undefined
                      }
                      onClick={() => openAgent(agent.id, section.id)}
                    >
                      <section.icon size={14} />
                      {section.label}
                      {section.id === "messages" && (
                        <small>
                          {
                            workspaceState.messages.filter(
                              (message) => message.agent_id === agent.id,
                            ).length
                          }
                        </small>
                      )}
                    </button>
                  ))}
                </nav>
              </section>
            ))}
          </div>
        </div>
        <div className="sidebar-bottom">
          <div className="demo-label">
            <span />
            Sample service scenario
          </div>
          <p>
            Real MCP interfaces.
            <br />
            PayPal sandbox payments.
          </p>
          <button
            className="profile"
            onClick={() => void command({ action: "logout" }, "logout")}
            title="Sign out"
          >
            <span className="avatar">M</span>
            <span>
              <strong>Maya</strong>
              <small>Private demo workspace</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <span className="mobile-brand">
            <Mail size={20} /> Mailbox
          </span>
          <span className="breadcrumb">
            Maya’s space <ChevronRight size={13} />{" "}
            {view === "agents"
              ? "Your agents"
              : activeAgent
                ? `${activeAgent.name} · ${view === "services" ? "Overview" : view === "dashboards" ? "Dashboard" : view === "connections" ? "Services" : view === "activity" ? "Activity" : "Inbox"}`
                : view === "services"
                  ? "My services"
                  : view === "activity"
                    ? "Wallet activity"
                    : view === "dashboards"
                      ? "Niche dashboards"
                      : view === "inbox"
                        ? "Before Mailbox"
                        : "Service messages"}
          </span>
          <div className="top-actions">
            <span className="sandbox-pill">
              <span />
              PayPal sandbox
            </span>
            <button
              className="icon-button"
              title="Refresh service state"
              onClick={() => void command({ action: "sync" }, "sync")}
              disabled={!!busy}
            >
              <RefreshCw size={16} className={busy === "sync" ? "spin" : ""} />
            </button>
          </div>
        </header>
        <main className="workspace">
          {error && (
            <div className="feedback error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="feedback" role="status">
              <Check size={17} />
              <span>{notice}</span>
              <button onClick={() => setNotice("")} aria-label="Dismiss notice">
                <X size={16} />
              </button>
            </div>
          )}
          {activeAgent && view !== "agents" && (
            <>
              <AgentIdentity
                agent={activeAgent}
                busy={!!busy}
                onConnect={() =>
                  void command(
                    { action: "connect_agent", agent_id: activeAgent.id },
                    "connect-agent",
                  ).then((result) => {
                    if (result)
                      setNotice(
                        `${activeAgent.name}’s address is ready. Use it for the services you choose.`,
                      );
                  })
                }
                onEdit={() => setAgentForm(activeAgent)}
              />
              <nav className="agent-workspace-tabs" aria-label="Agent sections">
                {agentSections.map((tab) => (
                  <button
                    key={tab.id}
                    aria-pressed={view === tab.id}
                    onClick={() => {
                      setView(tab.id);
                      setSelectedService(null);
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>
            </>
          )}
          {view === "agents" && workspaceState && (
            <AgentHome
              state={workspaceState}
              onOpen={openAgent}
              onCreate={() => setAgentForm("create")}
              onLoadDemo={() =>
                void command({ action: "seed_preview" }, "seed")
              }
            />
          )}
          {view === "dashboards" && (
            <NicheDashboard
              key={activeAgent?.id ?? "all"}
              state={state}
              {...(activeAgent ? { agent: activeAgent } : {})}
            />
          )}
          {(view === "services" || view === "connections") && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">A little less noise</div>
                  <h2>
                    {view === "connections"
                      ? "Services"
                      : priorityProposal
                        ? "Confirming your payment."
                        : result?.type === "options"
                          ? "Choose your service."
                          : result?.type === "market"
                            ? "Here’s what I found."
                            : result?.type === "answer"
                              ? "Here’s what I found."
                              : activeProposal?.status === "PAID"
                                ? "Your service is ready."
                                : activeProposal?.status === "WAITING"
                                  ? "Your rule is watching."
                                  : activeProposal &&
                                      ![
                                        "DECLINED",
                                        "BLOCKED",
                                        "EXPIRED",
                                      ].includes(activeProposal.status)
                                    ? "Review your proposal."
                                    : `What would you like ${activeAgent?.name ?? "your agent"} to do?`}
                  </h2>
                  <p>
                    Ask across your services. Every wallet acts on your terms.
                  </p>
                </div>
                <span className="date-label">
                  {new Date().toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    timeZone: "Asia/Dubai",
                  })}
                </span>
              </div>
              <div hidden={view === "connections"}>
                <section className="ask-surface">
                  <div
                    className="search-scope"
                    role="group"
                    aria-label="Search scope"
                  >
                    {[
                      { id: "services", label: "My services" },
                      { id: "market", label: "Across the market" },
                    ].map((scope) => (
                      <button
                        type="button"
                        key={scope.id}
                        aria-pressed={searchScope === scope.id}
                        onClick={() => {
                          setSearchScope(scope.id);
                          setResult(null);
                        }}
                        disabled={!!busy}
                      >
                        {scope.label}
                      </button>
                    ))}
                  </div>
                  <form
                    className="ask-form"
                    onSubmit={(e) => void submitAsk(e)}
                  >
                    <label className="sr-only" htmlFor="ask">
                      {activeAgent ? `Ask ${activeAgent.name}` : "Ask Mailbox"}
                    </label>
                    <Search size={21} />
                    <input
                      id="ask"
                      value={ask}
                      onChange={(e) => setAsk(e.target.value)}
                      placeholder={
                        searchScope === "market"
                          ? "Find coffee beans under $15…"
                          : "I want to watch The Lantern Coast…"
                      }
                      disabled={busy === "ask"}
                    />
                    <button
                      type="submit"
                      className="ask-submit"
                      aria-label="Send request"
                      disabled={!!busy || !ask.trim()}
                    >
                      {busy === "ask" ? (
                        <LoaderCircle className="spin" size={20} />
                      ) : (
                        <ArrowUp size={20} />
                      )}
                    </button>
                  </form>
                  {searchScope === "services" && (
                    <div className="example-row">
                      {samples.map((sample) => (
                        <button
                          key={sample.id}
                          onClick={() => void submitAsk(undefined, sample)}
                          disabled={!!busy}
                        >
                          <sample.icon size={14} />
                          {sample.label}
                          <ArrowUpRight size={12} />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                {searchScope === "services" && !state.configuration.model && (
                  <p className="connection-note">
                    Custom requests are not connected yet. The buttons above
                    open clearly labeled fixture walkthroughs.
                  </p>
                )}
                {busy === "ask" && (
                  <div className="thinking">
                    <LoaderCircle size={17} className="spin" />
                    {searchScope === "market"
                      ? "Searching products through Channel3…"
                      : "Checking your services and their terms…"}
                  </div>
                )}
                {result?.type === "market" &&
                  result.market &&
                  !priorityProposal && <MarketResults result={result.market} />}
                {result?.engine === "fixture" && (
                  <div className="walkthrough-label">
                    Fixture walkthrough · no model call
                  </div>
                )}
                {result?.type === "options" && !priorityProposal && (
                  <section className="result-section">
                    <div className="section-heading">
                      <h2>{result.title}</h2>
                      <button
                        className="text-button"
                        onClick={() => setResult(null)}
                      >
                        Close <X size={14} />
                      </button>
                    </div>
                    <div className="plan-options">
                      {result.options?.map((option) => (
                        <button
                          key={option.id}
                          className={`plan-option ${selectedOption === option.id ? "selected" : ""}`}
                          aria-pressed={selectedOption === option.id}
                          onClick={() => setSelectedOption(option.id)}
                        >
                          <span className="plan-top">
                            <ServiceMark category={option.category} />
                            <span className="radio-dot">
                              {selectedOption === option.id && <span />}
                            </span>
                          </span>
                          <strong>{option.name}</strong>
                          <span className="plan-price">
                            {money(option.amount)}
                            <small>
                              {option.kind === "subscription"
                                ? " / month"
                                : option.kind === "booking"
                                  ? " deposit"
                                  : " once"}
                            </small>
                          </span>
                          <span className="plan-terms">{option.terms}</span>
                          {option.kind === "subscription" && (
                            <span className="plan-foot">
                              <Clock size={12} />
                              One month, then cancel
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="result-action">
                      <p>
                        <ShieldCheck size={16} /> Your wallet limits apply to
                        every action.
                      </p>
                      <button
                        className="primary"
                        disabled={!!busy || !selectedOption}
                        onClick={() => {
                          const o = result.options?.find(
                            (o) => o.id === selectedOption,
                          );
                          if (o?.kind === "booking")
                            void submitAsk(undefined, samples[2]);
                          else
                            void command(
                              {
                                action: "propose",
                                service_id: selectedOption,
                                kind:
                                  o?.kind === "subscription"
                                    ? "subscribe"
                                    : "buy",
                              },
                              "propose",
                            );
                        }}
                      >
                        {busy === "propose" ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <>
                            Review proposal <ArrowRight size={17} />
                          </>
                        )}
                      </button>
                    </div>
                  </section>
                )}
                {result?.type === "answer" && !priorityProposal && (
                  <section className="answer-card">
                    <div className="eyebrow">From your services</div>
                    <h2>{result.answer}</h2>
                    {!!result.sources?.length && (
                      <div className="source-links">
                        {result.sources.map((id) => {
                          const m = state.messages.find((m) => m.id === id);
                          return m ? (
                            <button key={id} onClick={() => setOpenMessage(m)}>
                              <Mail size={13} />
                              {m.subject}
                              <ArrowUpRight size={12} />
                            </button>
                          ) : null;
                        })}
                      </div>
                    )}
                  </section>
                )}
                {activeProposal &&
                  !["DECLINED", "BLOCKED", "EXPIRED"].includes(
                    activeProposal.status,
                  ) &&
                  proposalWallet &&
                  (!!priorityProposal ||
                    (result?.type !== "options" &&
                      result?.type !== "answer" &&
                      result?.type !== "market")) && (
                    <ProposalCard
                      {...(activeAgent
                        ? {
                            agent: activeAgent,
                            onConnectAgent: () =>
                              void command(
                                {
                                  action: "connect_agent",
                                  agent_id: activeAgent.id,
                                },
                                "connect-agent",
                              ),
                          }
                        : {})}
                      errorMessage={failedAction === "approve" ? error : ""}
                      proposal={activeProposal}
                      wallet={proposalWallet}
                      busy={!!busy}
                      sourceMessages={state.messages.filter((m) =>
                        activeProposal.sources.includes(m.id),
                      )}
                      onSource={(id) =>
                        setOpenMessage(
                          state.messages.find((m) => m.id === id) ?? null,
                        )
                      }
                      onApprove={(rules) =>
                        void command(
                          { action: "approve", id: activeProposal.id, rules },
                          "approve",
                        )
                      }
                      onDecline={() =>
                        void command(
                          { action: "decline", id: activeProposal.id },
                          "decline",
                        )
                      }
                      onRefresh={() => void command({ action: "sync" }, "sync")}
                    />
                  )}
              </div>
              <section className="services-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      Your services{" "}
                      <span className="count">{state.wallets.length}</span>
                    </h2>
                    <p>One agent address. Separate service wallets.</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => void browse()}
                    disabled={!!busy}
                  >
                    Find a service <ArrowUpRight size={15} />
                  </button>
                </div>
                {state.wallets.length === 0 ? (
                  <div className="empty-services">
                    <span className="empty-symbol">
                      <LayoutGrid size={23} />
                    </span>
                    <h3>Your services will live here.</h3>
                    <p>
                      Choose a service from an answer above.
                      <br />
                      Its messages, spending and next charge stay together.
                    </p>
                    <div className="empty-hint">
                      <ShieldCheck size={14} />
                      Nothing can spend until you choose its permission.
                    </div>
                  </div>
                ) : (
                  <div className="service-list">
                    <div className="service-list-head">
                      <span>Service</span>
                      <span>Wallet spent</span>
                      <span>Available</span>
                      <span>Next step</span>
                      <span />
                    </div>
                    {state.wallets.map((wallet) => {
                      const latest = state.proposals.find(
                        (p) => p.wallet_id === wallet.id,
                      );
                      return (
                        <button
                          className="service-row"
                          key={wallet.id}
                          onClick={() => {
                            setSelectedService(wallet.service_id);
                            setView("messages");
                          }}
                        >
                          <span className="service-name">
                            <ServiceMark category={wallet.category} />
                            <span>
                              <strong>{wallet.name}</strong>
                              <small>
                                {wallet.status === "revoked"
                                  ? "PayPal disconnected"
                                  : wallet.status === "canceled"
                                    ? "Paid access ended"
                                    : wallet.paused
                                      ? "Spending paused"
                                      : wallet.status === "active"
                                        ? "Connected"
                                        : wallet.connected
                                          ? "PayPal connected"
                                          : "Ready to connect"}
                              </small>
                            </span>
                          </span>
                          <span className="amount-cell">
                            {money(wallet.spent)}
                            <small>
                              of {money(wallet.cap)} / {wallet.period}
                            </small>
                          </span>
                          <span className="amount-cell">
                            {money(wallet.available)}
                            {wallet.reserved > 0 && (
                              <small>{money(wallet.reserved)} reserved</small>
                            )}
                          </span>
                          <span className="next-cell">
                            {latest?.cancel_effective_at ? (
                              <>
                                <Clock size={13} />
                                <span>
                                  Cancels {date(latest.cancel_effective_at)}
                                </span>
                              </>
                            ) : latest?.status === "WAITING" ? (
                              <>
                                <Clock size={13} />
                                <span>Watching price</span>
                              </>
                            ) : latest?.status === "RECONCILING" ? (
                              <>
                                <Clock size={13} />
                                <span>Confirming payment</span>
                              </>
                            ) : (
                              <span>On your request</span>
                            )}
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
              <div className="trust-footer">
                <ShieldCheck size={16} />
                <span>
                  Services send the messages. Your agent connects the dots. Your
                  wallets set the limits.
                </span>
              </div>
            </>
          )}
          {view === "activity" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">A clear record</div>
                  <h1>Every wallet decision.</h1>
                  <p>What was allowed, what was declined, and why.</p>
                </div>
              </div>
              <div className="wallet-summary">
                {state.wallets.map((w) => (
                  <div key={w.id}>
                    <ServiceMark category={w.category} />
                    <span>{w.name}</span>
                    <strong>{money(w.available)}</strong>
                    <small>available of {money(w.cap)}</small>
                  </div>
                ))}
              </div>
              <section className="activity-list">
                {state.audit.length ? (
                  state.audit.map((event) => (
                    <div className="activity-row" key={event.id}>
                      <span
                        className={`event-icon ${event.action.includes("COMPLETED") ? "success" : ""}`}
                      >
                        <ShieldCheck size={17} />
                      </span>
                      <div>
                        <strong>
                          {event.action.toLowerCase().replaceAll("_", " ")}
                        </strong>
                        <p>{event.reason}</p>
                      </div>
                      <span>
                        {event.amount !== null ? money(event.amount) : ""}
                        <small>
                          {new Date(event.created_at).toLocaleTimeString(
                            "en-US",
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </small>
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-services">
                    <WalletIcon size={24} />
                    <h3>No spending decisions yet.</h3>
                    <p>Proposals, approvals and payments will appear here.</p>
                  </div>
                )}
              </section>
            </>
          )}
          {view === "messages" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">Messages with context</div>
                  <h1>{serviceWallet?.name ?? "Service messages"}</h1>
                  <p>
                    {serviceWallet?.email ??
                      "Original offers, confirmations and renewal notices."}
                  </p>
                </div>
                {selectedService && (
                  <button
                    className="text-button"
                    onClick={() => setSelectedService(null)}
                  >
                    All services <ArrowRight size={15} />
                  </button>
                )}
              </div>
              {serviceWallet && (
                <div className="service-detail-actions">
                  <button
                    className="secondary"
                    onClick={() => setEditingWallet(serviceWallet.id)}
                  >
                    <WalletIcon size={14} />
                    Wallet rules
                  </button>
                  <div>
                    <WalletIcon size={17} />
                    <strong>{money(serviceWallet.available)}</strong> available
                    ·{" "}
                    {serviceWallet.mode === "draft"
                      ? "Draft only"
                      : serviceWallet.mode === "ask"
                        ? "Ask every time"
                        : "Automatic within limits"}
                  </div>
                  <button
                    className="secondary"
                    onClick={() =>
                      void command(
                        {
                          action: "pause",
                          id: serviceWallet.id,
                          paused: !serviceWallet.paused,
                        },
                        "pause",
                      )
                    }
                    disabled={!!busy || serviceWallet.status === "revoked"}
                  >
                    {serviceWallet.paused ? (
                      <Play size={14} />
                    ) : (
                      <Pause size={14} />
                    )}{" "}
                    {serviceWallet.paused
                      ? "Resume spending"
                      : "Pause spending"}
                  </button>
                  {state.proposals.some(
                    (p) =>
                      p.wallet_id === serviceWallet.id &&
                      p.kind === "subscribe" &&
                      p.status === "PAID",
                  ) && (
                    <button
                      className="text-button"
                      onClick={() => {
                        const p = state.proposals.find(
                          (p) =>
                            p.wallet_id === serviceWallet.id &&
                            p.kind === "subscribe" &&
                            p.status === "PAID",
                        );
                        if (
                          p &&
                          confirm(
                            "Disable renewal and cancel at the end of the paid month? Your access stays active until then.",
                          )
                        )
                          void command(
                            { action: "cancel", id: p.id },
                            "cancel",
                          );
                      }}
                    >
                      Cancel subscription
                    </button>
                  )}
                </div>
              )}
              <div className="message-list">
                {filteredMessages.length ? (
                  filteredMessages.map((m) => (
                    <button
                      key={m.id}
                      className="message-row"
                      onClick={() => setOpenMessage(m)}
                    >
                      <span
                        className={`message-kind ${m.facts.suspicious ? "suspicious" : ""}`}
                      >
                        <Mail size={16} />
                      </span>
                      <span>
                        <strong>{m.subject}</strong>
                        <small>
                          {m.from}
                          <span className="email-type">
                            {m.facts.suspicious
                              ? "Flagged"
                              : m.kind === "offer" &&
                                  m.facts.expires &&
                                  new Date(m.facts.expires) < new Date()
                                ? "Expired offer"
                                : m.kind}
                          </span>
                          {m.format === "html" && (
                            <span className="email-type">HTML</span>
                          )}
                        </small>
                        <p>{m.text.slice(0, 130)}</p>
                      </span>
                      <span className="message-date">
                        {date(m.received_at)}
                        <small>
                          {m.origin === "agentmail"
                            ? m.scenario || m.id.startsWith("fixture:")
                              ? "Received sample"
                              : "Received"
                            : "Fixture preview"}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))
                ) : (
                  <div className="empty-services">
                    <Mail size={24} />
                    <h3>Waiting for service mail.</h3>
                    <p>
                      A real received message appears here after delivery.
                      <br />A sent confirmation is never shown as a received
                      one.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
          {view === "inbox" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    The same messages, without a guide
                  </div>
                  <h1>Before Mailbox.</h1>
                  <p>
                    A generic inbox view of the same fixture and received email.
                  </p>
                </div>
                <span className="subtle-pill">
                  {state.messages.length} messages
                </span>
              </div>
              <div className="old-inbox-toolbar">
                <Search size={17} />
                <span>Search messages</span>
                <MoreHorizontal size={19} />
              </div>
              <div className="old-inbox">
                {state.messages.length ? (
                  state.messages.map((m) => (
                    <button key={m.id} onClick={() => setOpenMessage(m)}>
                      <span className="fake-checkbox" />
                      <span className="old-from">{m.from}</span>
                      <strong>{m.subject}</strong>
                      <span>{m.text.slice(0, 75)}</span>
                      <small>{date(m.received_at)}</small>
                    </button>
                  ))
                ) : (
                  <div className="empty-services">
                    <Mail size={24} />
                    <h3>No fixture emails seeded yet.</h3>
                    <p>
                      The setup and seed command will populate both views from
                      the same files.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </main>
        <details className="demo-controls">
          <summary>Demo setup</summary>
          <div>
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => void command({ action: "seed_preview" }, "seed")}
            >
              Load preview emails
            </button>
            <button
              className="secondary"
              disabled={!!busy || !state.configuration.email}
              onClick={() => void command({ action: "seed_live" }, "seed")}
            >
              Send live fixture emails
            </button>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() => {
                if (
                  confirm(
                    "Reset this demo workspace? Old wallets and rules will be paused, and controlled streaming access will be canceled. Past sandbox payments remain recorded.",
                  )
                )
                  void command({ action: "reset" }, "reset");
              }}
            >
              Reset workspace
            </button>
          </div>
          <p>
            Preview mail is labeled. Live seeding sends the same 24 fixtures
            through the email provider. Reset never erases PayPal transactions.
          </p>
        </details>
        <footer className="app-footer">
          <span>Mailbox · one service, one wallet</span>
          <button className="sdk-link" onClick={() => setShowSdk(true)}>
            <Code2 size={13} /> MCP service SDK{" "}
            <span className="footer-dot">·</span> Invented service fixtures
          </button>
        </footer>
      </div>
      {openMessage && (
        <NativeDialog
          title={openMessage.subject}
          onClose={() => setOpenMessage(null)}
        >
          <div className="eyebrow">
            {openMessage.origin === "agentmail"
              ? openMessage.scenario || openMessage.id.startsWith("fixture:")
                ? "Original received sample email"
                : "Original received email"
              : "Fixture preview"}
          </div>
          <h2>{openMessage.subject}</h2>
          <div className="message-meta">
            {openMessage.from} · {date(openMessage.received_at)}
          </div>
          {(openMessage.facts.coupon_code ||
            (openMessage.facts.discount_percent !== undefined &&
              openMessage.facts.discount_percent !== null)) && (
            <div className="offer-summary">
              {openMessage.facts.discount_percent !== undefined &&
                openMessage.facts.discount_percent !== null && (
                  <span>
                    <strong>{openMessage.facts.discount_percent}%</strong>{" "}
                    immediate discount
                  </span>
                )}
              {openMessage.facts.cashback_percent !== undefined &&
                openMessage.facts.cashback_percent !== null && (
                  <span>
                    <strong>{openMessage.facts.cashback_percent}%</strong>{" "}
                    advertised cashback
                  </span>
                )}
              {openMessage.facts.coupon_code && (
                <span>
                  Code <strong>{openMessage.facts.coupon_code}</strong>
                </span>
              )}
              <small>
                Cashback stays separate from the checkout discount. Exact
                eligibility and expiry require the service terms.
              </small>
            </div>
          )}
          {openMessage.media?.needs_vision && (
            <div className="feedback">
              This email has image-only offer content that has not been read
              yet.
            </div>
          )}
          {openMessage.media?.unread_attachments && (
            <div className="feedback">
              This message includes attachments that have not been read yet.
            </div>
          )}
          {openMessage.facts.suspicious && (
            <div className="feedback error">
              Permission-changing content was quarantined. No payment was
              authorized.
            </div>
          )}
          <div className="email-extraction">
            <h3>What Mailbox found</h3>
            <dl>
              <div>
                <dt>Message type</dt>
                <dd>{openMessage.kind}</dd>
              </div>
              {openMessage.facts.item && (
                <div>
                  <dt>Item</dt>
                  <dd>{openMessage.facts.item}</dd>
                </div>
              )}
              {openMessage.facts.amount_minor !== null && (
                <div>
                  <dt>Amount in email</dt>
                  <dd>{money(openMessage.facts.amount_minor)}</dd>
                </div>
              )}
              {openMessage.facts.expires && (
                <div>
                  <dt>Offer expiry</dt>
                  <dd>
                    {date(openMessage.facts.expires)}
                    {new Date(openMessage.facts.expires) < new Date()
                      ? " · expired"
                      : ""}
                  </dd>
                </div>
              )}
            </dl>
            {openMessage.scenario && (
              <p className="email-scenario">
                Demo variant: {openMessage.scenario}
              </p>
            )}
          </div>
          {openMessage.html && (
            <iframe
              className="email-preview"
              title="Original email preview"
              sandbox=""
              srcDoc={
                "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\"><style>body{font:15px/1.65 system-ui;padding:24px;color:#23372c}h1{font-size:28px}h2{font-size:21px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:12px;text-align:left}</style>" +
                openMessage.html
              }
            />
          )}
          <details open={!openMessage.html}>
            <summary>
              {openMessage.html ? "Extracted text" : "Original message"}
            </summary>
            <pre>{openMessage.text}</pre>
          </details>
        </NativeDialog>
      )}
      {agentForm && (
        <NativeDialog
          title={agentForm === "create" ? "Create an agent" : "Edit agent"}
          onClose={() => setAgentForm(null)}
        >
          <AgentForm
            {...(agentForm !== "create" ? { initial: agentForm } : {})}
            busy={!!busy}
            error={error}
            onCancel={() => setAgentForm(null)}
            onSubmit={async (details) => {
              const created = await command(
                {
                  action:
                    agentForm === "create" ? "create_agent" : "update_agent",
                  ...details,
                  ...(agentForm !== "create" ? { agent_id: agentForm.id } : {}),
                },
                "agent",
              );
              if (!created?.agent) return;
              if (agentForm === "create") {
                const connected = await command(
                  { action: "connect_agent", agent_id: created.agent.id },
                  "connect-agent",
                );
                if (!connected) return;
              }
              setAgentForm(null);
              openAgent(created.agent.id);
            }}
          />
        </NativeDialog>
      )}
      {showSdk && (
        <NativeDialog
          title="One service, one configuration"
          onClose={() => setShowSdk(false)}
        >
          <div className="eyebrow">Used by our own fixture services</div>
          <h2>One service. One configuration.</h2>
          <p className="sdk-description">
            The same thin SDK exposes MCP tools, verifies PayPal callbacks and
            produces structured receipts for each supported fixture service.
          </p>
          <pre className="sdk-code">{`createService({
  id: 'coast-screen',
  name: 'Coast Screen',
  category: 'entertainment',
  plans: [{
    id: 'monthly',
    name: 'One month of Coast Screen',
    amount_minor: 799,
    period: 'month',
    terms: 'One month, renewal disabled.'
  }],
  paypalMerchant: sandboxMerchantId
});`}</pre>
          <p className="sdk-description">
            MCP and PayPal are the standards underneath. This demonstrates an
            integration path with invented services; no outside merchant
            adoption is claimed.
          </p>
        </NativeDialog>
      )}
      {editingWallet && state.wallets.find((w) => w.id === editingWallet) && (
        <NativeDialog
          title="Service wallet rules"
          onClose={() => setEditingWallet(null)}
        >
          <div className="eyebrow">You set the limits</div>
          <h2>{state.wallets.find((w) => w.id === editingWallet)!.name}</h2>
          {state.wallets.find((w) => w.id === editingWallet)!.status ===
            "revoked" && (
            <p className="sdk-description">
              Payment permission is disconnected.
              {state.wallets.find((w) => w.id === editingWallet)!
                .revocation_pending
                ? " Provider cleanup is pending; new spending is already blocked."
                : " A fresh connection is required before this service can spend."}
            </p>
          )}
          <WalletRuleForm
            errorMessage={error}
            key={`${editingWallet}:${state.wallets.find((w) => w.id === editingWallet)!.revision}`}
            wallet={state.wallets.find((w) => w.id === editingWallet)!}
            busy={!!busy}
            expanded
            buttonLabel="Save wallet rules"
            onSave={async (rules) => {
              const result = await command(
                { action: "rules", id: editingWallet, rules },
                "rules",
              );
              if (result) {
                setEditingWallet(null);
                setNotice(
                  "Wallet rules saved. Pending proposals must use the new permission.",
                );
              }
            }}
          />
          {state.wallets.find((w) => w.id === editingWallet)!.status ===
          "revoked" ? (
            <button
              className="secondary full"
              disabled={
                !!busy ||
                state.wallets.find((w) => w.id === editingWallet)!
                  .revocation_pending
              }
              onClick={async () => {
                const r = await command(
                  { action: "reconnect", id: editingWallet },
                  "reconnect",
                );
                if (r) {
                  setEditingWallet(null);
                  setNotice(
                    "Review a fresh proposal to connect PayPal again. Existing spending stays recorded.",
                  );
                }
              }}
            >
              Start a fresh connection
            </button>
          ) : (
            <button
              className="disconnect-button"
              disabled={!!busy}
              onClick={async () => {
                if (
                  !confirm(
                    "Disconnect this service’s payment permission? New spending stops now. Paid access and already dispatched payments may continue.",
                  )
                )
                  return;
                const r = await command(
                  { action: "revoke", id: editingWallet },
                  "revoke",
                );
                if (r) {
                  setEditingWallet(null);
                  setNotice(
                    "Payment permission disconnected. Saved-token cleanup will retry if needed.",
                  );
                }
              }}
            >
              Disconnect PayPal permission
            </button>
          )}
        </NativeDialog>
      )}
      {inFlight > 0 && (
        <div className="pending-toast">
          <LoaderCircle size={16} className="spin" />
          {inFlight} payment{inFlight > 1 ? "s" : ""} awaiting confirmation.
          Reserved funds remain counted.
        </div>
      )}
      <nav className="mobile-nav">
        {[
          { id: "agents", label: "Agents", icon: LayoutGrid },
          { id: "activity", label: "Wallets", icon: WalletIcon },
          { id: "dashboards", label: "Dashboards", icon: BarChart3 },
          { id: "messages", label: "Messages", icon: Mail },
        ].map((item) => (
          <button
            key={item.id}
            className={view === item.id ? "active" : ""}
            onClick={() => {
              setView(item.id);
              if (item.id === "agents") setActiveAgentId(null);
            }}
          >
            <item.icon size={19} />
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function ProposalCard({
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
}: {
  proposal: Proposal;
  agent?: PublicAgent;
  onConnectAgent?: () => void;
  wallet: PublicWallet;
  busy: boolean;
  onApprove: (rules: Record<string, unknown>) => void;
  onDecline: () => void;
  onRefresh: () => void;
  errorMessage: string;
  sourceMessages: Message[];
  onSource: (id: string) => void;
}) {
  const finished = ["PAID", "DECLINED", "BLOCKED", "EXPIRED"].includes(
      p.status,
    ),
    paying = ["PAYING", "RECONCILING"].includes(p.status),
    waiting = p.status === "WAITING";
  return (
    <section className={`proposal-card ${p.status === "PAID" ? "paid" : ""}`}>
      <div className="proposal-main">
        <div className="eyebrow">
          {p.status === "PAID"
            ? "Confirmed by the service"
            : waiting
              ? "Standing instruction"
              : paying
                ? "Payment in progress"
                : "Your proposal"}
        </div>
        <div className="proposal-title">
          <ServiceMark category={w.category} />
          <div>
            <h2>{p.title}</h2>
            <p>{w.name}</p>
          </div>
          <span className="status-pill">
            {p.status === "PAID" ? (
              <>
                <Check size={13} /> Paid
              </>
            ) : p.status === "WAITING" ? (
              <>
                <Clock size={13} /> Watching
              </>
            ) : (
              p.status.toLowerCase().replaceAll("_", " ")
            )}
          </span>
        </div>
        <p className="proposal-rationale">{p.rationale}</p>
        {p.booking && (
          <div className="booking-details">
            <Clock size={14} />
            {date(p.booking.date + "T12:00:00+04:00")} · {p.booking.time} ·{" "}
            {p.booking.party_size} people · Asia/Dubai
          </div>
        )}
        {p.cancel_effective_at && (
          <div className="cancellation-note">
            <Check size={14} />
            Renewal disabled. Cancels {date(p.cancel_effective_at)}.
          </div>
        )}
        {p.reason && <p className="inline-error">{p.reason}</p>}
        <div className="proposal-price">
          <strong>
            {p.kind === "condition"
              ? `Below ${money(p.condition_under ?? 3000)}`
              : money(p.amount)}
          </strong>
          <span>
            {p.kind === "subscribe"
              ? "one paid month · no renewal"
              : p.kind === "book"
                ? "booking deposit"
                : p.kind === "condition"
                  ? "one purchase · exact variant"
                  : "all-in total"}
          </span>
        </div>
        {p.comparison && (
          <div className="deal-comparison">
            <h3>Why this deal</h3>
            <table>
              <thead>
                <tr>
                  <th>Pack</th>
                  <th>Total</th>
                  <th>Unit price</th>
                </tr>
              </thead>
              <tbody>
                {p.comparison.rows.map((row) => (
                  <tr
                    key={`${row.service_id}:${row.item_id}`}
                    className={
                      row.item_id === p.comparison!.selected_item_id &&
                      row.service_id === p.comparison!.selected_service_id
                        ? "chosen"
                        : ""
                    }
                  >
                    <td>
                      {row.pack}
                      {row.item_id === p.comparison!.selected_item_id &&
                        row.service_id ===
                          p.comparison!.selected_service_id && (
                          <Check size={12} />
                        )}{" "}
                      {!row.eligible && <small>Above limit</small>}
                    </td>
                    <td>{money(row.amount)}</td>
                    <td>
                      {money(row.unit_price)}/{row.unit_label}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              {p.comparison.scope}. Only current merchant-quoted totals affect
              payment.
            </p>
          </div>
        )}
        {!!sourceMessages.length && (
          <div className="source-links">
            {sourceMessages.map((message) => (
              <button key={message.id} onClick={() => onSource(message.id)}>
                <Mail size={12} />
                {message.subject}
                <ArrowUpRight size={12} />
              </button>
            ))}
          </div>
        )}
        {p.capture_id && (
          <details className="payment-detail">
            <summary>
              Payment reference <ExternalLink size={12} />
            </summary>
            <code>{p.capture_id}</code>
            <small>PayPal sandbox capture</small>
          </details>
        )}
      </div>
      <div className="proposal-wallet">
        {agent && (
          <div className="proposal-actor">
            <span>Acting as {agent.name}</span>
            <strong>
              {agent.email ?? "Create this agent’s address first"}
            </strong>
            {!agent.email && onConnectAgent && (
              <button
                className="text-button"
                onClick={onConnectAgent}
                disabled={busy}
              >
                Create agent address
              </button>
            )}
          </div>
        )}
        <div className="wallet-label">
          <WalletIcon size={16} />
          {w.name} wallet
        </div>
        <div className="wallet-balance">
          <strong>{money(w.available)}</strong>
          <span>available · {w.period}</span>
        </div>
        <div className="budget-track">
          <span
            style={{
              width: `${Math.min(100, (100 * (w.spent + w.reserved)) / Math.max(1, w.cap))}%`,
            }}
          />
        </div>
        <p className="budget-caption">
          {money(w.spent)} spent
          {w.reserved > 0 ? ` · ${money(w.reserved)} reserved` : ""} of{" "}
          {money(w.cap)}
        </p>
        {w.prior_reserved > 0 && (
          <p className="permission-caption">
            {money(w.prior_reserved)} remains reserved from an earlier period.
          </p>
        )}
        {!finished && !paying && !waiting && (
          <WalletRuleForm
            errorMessage={errorMessage}
            key={`${p.id}:${w.revision}`}
            wallet={w}
            busy={busy}
            requirePayment
            buttonLabel={
              p.kind === "condition"
                ? "Approve price rule"
                : !w.connected
                  ? "Approve & connect PayPal"
                  : `Approve ${money(p.amount)}`
            }
            onSave={onApprove}
            onDecline={onDecline}
          />
        )}
        {paying && (
          <>
            <button
              className="secondary full"
              disabled={busy}
              onClick={onRefresh}
            >
              <RefreshCw size={15} />
              Check payment
            </button>
            <p className="permission-caption">
              The original payment is reconciled with its original request ID.
            </p>
          </>
        )}
        {waiting && (
          <p className="permission-caption">
            <Clock size={14} />
            The exact item is watched until{" "}
            {p.condition_expires
              ? date(p.condition_expires)
              : "the chosen expiry"}
            . The rule can buy once.
          </p>
        )}
        {p.status === "PAID" && (
          <p className="permission-caption">
            <ShieldCheck size={16} />
            Payment verified. The service sends its receipt to{" "}
            {w.email ?? "its dedicated address"}.
          </p>
        )}
      </div>
    </section>
  );
}

function NativeDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="message-modal native-dialog"
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <button
        className="modal-close icon-button"
        aria-label="Close dialog"
        onClick={onClose}
        autoFocus
      >
        <X size={20} />
      </button>
      {children}
    </dialog>
  );
}
