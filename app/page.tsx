"use client";
import dynamic from "next/dynamic";
import { MarketResults } from "./market-results";
import { AgentHeader, AgentForm } from "./agent-home";
import { Home } from "./home";
import { ProposalCard } from "./proposal-card";
import { Digest } from "./digest";
import { ReplyCard, type ReplyDraft } from "./reply-card";
import {
  isExpiredOffer,
  isDuplicateSubscription,
  money,
  needsYou,
  senderName,
  shortDate as date,
} from "./agent-scope";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  LinkButton,
  SectionHead,
  Tabs,
  Tile,
} from "./ui";
import { Avatar, lookFor } from "./ui/avatar";
import type { MarketResult } from "../src/market";
const NicheDashboard = dynamic(() => import("@mailbox/dashboard"), {
  ssr: false,
  loading: () => <p>Opening your dashboard…</p>,
});
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Mail,
  ShieldCheck,
  X,
  Wallet as WalletIcon,
  ChevronRight,
  Search,
  Play,
  Coffee,
  Utensils,
  PawPrint,
  ArrowUp,
  LoaderCircle,
  Pause,
  MoreHorizontal,
  KeyRound,
  LogOut,
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
/** The market half of a request: it runs beside the services half and fails on its own. */
type MarketSearch =
  | { status: "searching" }
  | { status: "found"; result: MarketResult }
  | { status: "failed"; message: string };
type Result = {
  type: "options" | "answer" | "proposal" | "market" | "digest" | "reply";
  draft?: ReplyDraft;
  market?: MarketResult;
  title?: string;
  options?: Option[];
  answer?: string;
  sources?: string[];
  proposal?: Proposal;
  engine?: string;
};
const agentSections = [
  { id: "services", label: "Overview" },
  { id: "messages", label: "Inbox" },
  { id: "dashboards", label: "Dashboard" },
  { id: "activity", label: "Activity" },
];
const sentenceCase = (value: string) => {
  const text = value.toLowerCase().replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
/** Says honestly whether a message was really delivered or is a sample. */
const originLabel = (message: Message, long = false) =>
  message.origin === "agentmail"
    ? message.scenario || message.id.startsWith("fixture:")
      ? long
        ? "Sample message, received by email"
        : "Received sample"
      : long
        ? "Received by email"
        : "Received"
    : long
      ? "Sample preview, not sent by email"
      : "Sample preview";
const emailFrame =
  "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\"><style>body{font:15px/1.65 system-ui;padding:24px;color:#121417}h1{font-size:28px}h2{font-size:21px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:12px;text-align:left}</style>";
const samples = [
  {
    id: "film",
    text: "I want to watch The Lantern Coast",
    label: "Watch a film",
  },
  {
    id: "coffee",
    text: "Find me the cheapest coffee deal this week",
    label: "Find a coffee deal",
  },
  {
    id: "dining",
    text: "Book a restaurant near the marina for Friday at 7 pm for two people",
    label: "Book dinner",
  },
  {
    id: "pets",
    text: "Reorder the 3 kg adult dog food when its total price drops below $30",
    label: "Restock dog food",
  },
];
type Sample = (typeof samples)[number];
const categorySample: Record<string, string> = {
  entertainment: "film",
  groceries: "coffee",
  dining: "dining",
  pets: "pets",
};
/** What this agent can be asked in one click: a digest, its own jobs, a reply. */
function suggestionsFor(agent: PublicAgent, state: AppState): Sample[] {
  const categories = new Set(
    [agent.template, ...state.wallets.map((wallet) => wallet.category)].filter(
      (category): category is string => !!category,
    ),
  );
  const latest = state.messages
    .filter((message) => !message.facts.suspicious)
    .sort((a, b) => b.received_at.localeCompare(a.received_at))[0];
  return [
    { id: "digest", text: "What’s new?", label: "What’s new?" },
    ...samples.filter((sample) =>
      [...categories].some(
        (category) => categorySample[category] === sample.id,
      ),
    ),
    ...(latest
      ? [
          {
            id: "reply",
            text: `Reply to ${senderName(latest.from)} about “${latest.subject}”`,
            label: `Reply to ${senderName(latest.from)}`,
          },
        ]
      : []),
  ];
}
export default function Mailbox() {
  const [workspaceState, setState] = useState<AppState | null>(null),
    [needsLogin, setNeedsLogin] = useState(false),
    [loginKey, setLoginKey] = useState("");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
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
    setView(section);
    setResult(null);
    setMarket(null);
    setAsk("");
    setSelectedService(null);
    setError("");
    setNotice("");
  }
  const [view, setView] = useState("agents"),
    [ask, setAsk] = useState(""),
    [market, setMarket] = useState<MarketSearch | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState(""),
    [failedAction, setFailedAction] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [selectedService, setSelectedService] = useState<string | null>(null),
    [openMessage, setOpenMessage] = useState<Message | null>(null),
    [selectedOption, setSelectedOption] = useState("coast-screen"),
    [showSdk, setShowSdk] = useState(false),
    [demoOpen, setDemoOpen] = useState(false),
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
  const demoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!demoOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!demoRef.current?.contains(event.target as Node)) setDemoOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDemoOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [demoOpen]);
  // A proposal, digest or reply draft renders at the top of the agent page; bring it into view.
  const leadResult =
    result?.type === "proposal"
      ? result.proposal?.id
      : result?.type === "digest" || result?.type === "reply"
        ? result
        : undefined;
  useEffect(() => {
    if (leadResult) window.scrollTo({ top: 0 });
  }, [leadResult]);
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
          data.workspaceRetained
            ? "Demo reset. Spending is paused; agent addresses, messages and payment history are kept."
            : "Fresh workspace opened. Old wallets are paused and past sandbox payments remain recorded.",
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
  async function submitAsk(event?: FormEvent, example?: Sample) {
    event?.preventDefault();
    const text = example?.text ?? ask.trim();
    if (!text) return;
    setAsk(text);
    setView("services");
    // A typed request checks the owner's services and the wider market together.
    // Scripted samples only replay a services walkthrough.
    const actor = activeAgentId;
    if (example) setMarket(null);
    else {
      setMarket({ status: "searching" });
      void fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "market_search",
          text,
          ...(actor ? { agent_id: actor } : {}),
        }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (actorRef.current !== actor) return;
          setMarket(
            response.ok
              ? { status: "found", result: data }
              : {
                  status: "failed",
                  message: data.message ?? "The market search did not finish.",
                },
          );
        })
        .catch(() => {
          if (actorRef.current === actor)
            setMarket({
              status: "failed",
              message: "The market search did not finish.",
            });
        });
    }
    const answer = await command(
      { action: "ask", text, ...(example ? { example: example.id } : {}) },
      "ask",
    );
    // The services half can itself answer with market results; show them once.
    if (answer?.type === "market") setMarket(null);
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
  const newest = state?.proposals.find(
    (p) =>
      [
        "NEEDS_APPROVAL",
        "APPROVED",
        "WAITING",
        "PAYING",
        "RECONCILING",
      ].includes(p.status) && !isDuplicateSubscription(state, p),
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
      <main className="ui-center">
        <span className="ui-brand">
          <span className="ui-brand-mark">
            <Mail size={13} />
          </span>
          <span>Mailbox</span>
        </span>
        <h1 className="ui-title">Your services, your terms</h1>
        <p className="ui-sub is-flush">
          A demo with invented services on the PayPal sandbox. No real money
          moves.
        </p>
        <form
          className="ui-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await command({ action: "login", key: loginKey }, "login");
          }}
        >
          <label htmlFor="demo-key">
            Demo access key
            <input
              id="demo-key"
              type="password"
              value={loginKey}
              onChange={(e) => setLoginKey(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="ui-note is-danger" role="alert">
              {error}
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            className="is-wide"
            busy={!!busy}
            disabled={!!busy}
          >
            Open Mailbox
          </Button>
        </form>
      </main>
    );
  if (!state || !workspaceState)
    return (
      <div className="ui-center is-quiet" role="status">
        <LoaderCircle size={18} className="spin" />
        <p>Opening your services</p>
      </div>
    );
  // Agent screens need an agent; without one only the workspace screens exist.
  const screen = activeAgent
    ? view === "agents" || view === "inbox"
      ? "services"
      : view
    : view === "messages" || view === "inbox"
      ? view
      : "agents";
  const needs = needsYou(workspaceState);
  const activeAgentIndex = activeAgent
    ? workspaceState.agents.indexOf(activeAgent)
    : -1;
  const editedWallet = state.wallets.find((w) => w.id === editingWallet);
  const showProposal =
    !!activeProposal &&
    !["DECLINED", "BLOCKED", "EXPIRED"].includes(activeProposal.status) &&
    !isDuplicateSubscription(state, activeProposal) &&
    !!proposalWallet &&
    (!!priorityProposal ||
      (result?.type !== "options" &&
        result?.type !== "answer" &&
        result?.type !== "market" &&
        result?.type !== "digest" &&
        result?.type !== "reply"));
  function openWorkspace(id: string) {
    setView(id);
    setActiveAgentId(null);
    setResult(null);
    setMarket(null);
    setSelectedService(null);
  }
  const demo = (run: () => void) => () => {
    setDemoOpen(false);
    run();
  };
  return (
    <div className="ui-shell">
      <aside className="ui-side">
        <a className="ui-brand" href="/">
          <span className="ui-brand-mark">
            <Mail size={13} />
          </span>
          <span>Mailbox</span>
        </a>
        <div className="ui-side-scroll">
          <nav aria-label="Your space">
            <button
              className="ui-nav"
              aria-current={screen === "agents" ? "page" : undefined}
              onClick={() => openWorkspace("agents")}
            >
              Home{" "}
              {needs.length > 0 && (
                <span className="ui-nav-count is-hot">{needs.length}</span>
              )}
            </button>
            <button
              className="ui-nav"
              aria-current={
                !activeAgent && screen === "messages" ? "page" : undefined
              }
              onClick={() => openWorkspace("messages")}
            >
              Messages{" "}
              {workspaceState.messages.length > 0 && (
                <span className="ui-nav-count">
                  {workspaceState.messages.length}
                </span>
              )}
            </button>
          </nav>
          <span className="ui-side-label" id="agents-label">
            Agents
          </span>
          <nav aria-labelledby="agents-label">
            {workspaceState.agents.map((agent, index) => {
              const waiting = needs.filter(
                (need) => need.agent.id === agent.id,
              );
              return (
                <button
                  key={agent.id}
                  className="ui-nav"
                  aria-label={`Open ${agent.name}`}
                  aria-current={activeAgentId === agent.id ? "page" : undefined}
                  title={
                    waiting.length
                      ? `${waiting.length} thing${waiting.length > 1 ? "s" : ""} need${waiting.length > 1 ? "" : "s"} you`
                      : undefined
                  }
                  onClick={() => openAgent(agent.id)}
                >
                  <Avatar look={lookFor(agent, index)} />
                  {agent.name}
                  {waiting.length > 0 && (
                    <span className="ui-nav-count is-hot">
                      {waiting.length}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              className="ui-nav is-new"
              onClick={() => setAgentForm("create")}
            >
              <span className="ui-quiet">+ New agent</span>
            </button>
          </nav>
        </div>
        <div className="ui-side-foot" ref={demoRef}>
          <Tile name="Maya" />
          <span className="ui-who">Maya</span>
          <Button
            variant="small"
            aria-expanded={demoOpen}
            aria-haspopup="true"
            onClick={() => setDemoOpen((open) => !open)}
          >
            Demo
          </Button>
          <Button
            variant="icon"
            title="Sign out"
            aria-label="Sign out"
            onClick={() => void command({ action: "logout" }, "logout")}
          >
            <LogOut size={15} />
          </Button>
          <small>
            {workspaceState.shared_demo
              ? "Shared demo workspace"
              : "Private demo workspace"}
          </small>
          {demoOpen && (
            <div className="ui-menu">
              <button
                className="ui-nav"
                onClick={demo(() => openWorkspace("inbox"))}
              >
                Before Mailbox
              </button>
              <button
                className="ui-nav"
                disabled={!!busy}
                onClick={demo(
                  () => void command({ action: "seed_preview" }, "seed"),
                )}
              >
                Load sample messages
              </button>
              <button
                className="ui-nav"
                disabled={!!busy || !state.configuration.email}
                onClick={demo(
                  () =>
                    void command({ action: "seed_live" }, "seed").then(
                      (data) => {
                        if (data)
                          setNotice(
                            `${data.sent} sample messages sent to connected agents. Other agents keep their previews.`,
                          );
                      },
                    ),
                )}
              >
                Send samples by email
              </button>
              <button
                className="ui-nav"
                disabled={!!busy}
                onClick={demo(() => void command({ action: "sync" }, "sync"))}
              >
                Refresh service state
              </button>
              <button className="ui-nav" onClick={demo(() => setShowSdk(true))}>
                MCP service SDK
              </button>
              <hr />
              <button
                className="ui-nav"
                disabled={!!busy}
                onClick={demo(() => {
                  if (
                    confirm(
                      workspaceState.shared_demo
                        ? "Reset Maya’s shared demo? Spending will be paused, pending actions blocked and controlled streaming access canceled. Agent addresses and payment history stay recorded."
                        : "Reset this demo workspace? Old wallets and rules will be paused, and controlled streaming access will be canceled. Past sandbox payments remain recorded.",
                    )
                  )
                    void command({ action: "reset" }, "reset");
                })}
              >
                Reset workspace
              </button>
              <p>
                PayPal sandbox with invented services. No real money moves, and
                a reset never erases PayPal transactions.
              </p>
            </div>
          )}
        </div>
      </aside>
      <main className="ui-main">
        {error && (
          <Banner tone="danger" onDismiss={() => setError("")}>
            {error}
          </Banner>
        )}
        {notice && <Banner onDismiss={() => setNotice("")}>{notice}</Banner>}
        {screen === "agents" && (
          <Home
            state={workspaceState}
            busy={!!busy}
            onOpenAgent={openAgent}
            onOpenMessage={setOpenMessage}
            onPayInvoice={(message, agentId) =>
              void command(
                { action: "pay_invoice", id: message.id },
                "pay-invoice",
              ).then((data) => {
                if (!data?.proposal) return;
                openAgent(agentId);
                setResult({ type: "proposal", proposal: data.proposal });
              })
            }
            onDismiss={(message) =>
              void command(
                { action: "dismiss_message", id: message.id },
                "dismiss",
              )
            }
            onDecline={(id) =>
              void command({ action: "decline", id }, "decline")
            }
            onCreate={() => setAgentForm("create")}
            onLoadDemo={() => void command({ action: "seed_preview" }, "seed")}
          />
        )}
        {activeAgent && (
          <div className="ui-col">
            <AgentHeader
              agent={activeAgent}
              index={activeAgentIndex}
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
            <Tabs
              label={`${activeAgent.name} sections`}
              value={screen}
              onChange={(id) => {
                setView(id);
                setSelectedService(null);
              }}
              items={agentSections.map((section) =>
                section.id === "messages"
                  ? { ...section, count: state.messages.length }
                  : section,
              )}
            />
          </div>
        )}
        {screen === "dashboards" && (
          <NicheDashboard
            key={activeAgent?.id ?? "all"}
            state={state}
            {...(activeAgent ? { agent: activeAgent } : {})}
          />
        )}
        {screen === "services" && activeAgent && (
          <div className="ui-col">
            {showProposal && activeProposal && proposalWallet && (
              <ProposalCard
                agent={activeAgent}
                onConnectAgent={() =>
                  void command(
                    { action: "connect_agent", agent_id: activeAgent.id },
                    "connect-agent",
                  )
                }
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
            {!showProposal && result?.type === "digest" && (
              <Digest
                state={state}
                agent={activeAgent}
                busy={!!busy}
                onOpenMessage={setOpenMessage}
                onReviewProposal={() => setResult(null)}
                onPayInvoice={(message) =>
                  void command(
                    { action: "pay_invoice", id: message.id },
                    "pay-invoice",
                  )
                }
                onDismiss={(message) =>
                  void command(
                    { action: "dismiss_message", id: message.id },
                    "dismiss",
                  )
                }
              />
            )}
            {!showProposal && result?.type === "reply" && result.draft && (
              <ReplyCard
                key={`${result.draft.message_id}:${result.draft.body}`}
                draft={result.draft}
                agent={activeAgent}
                busy={!!busy}
                onDiscard={() => setResult(null)}
                onConnectAgent={() =>
                  void command(
                    { action: "connect_agent", agent_id: activeAgent.id },
                    "connect-agent",
                  )
                }
                onSend={async (body, requestId) => {
                  const draft = result.draft!;
                  try {
                    const response = await fetch("/api/command", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "send_reply",
                        id: draft.message_id,
                        body,
                        request_id: requestId,
                      }),
                    });
                    const data = await response.json();
                    if (!response.ok)
                      return data.message ?? "The reply could not be sent.";
                    await refresh();
                    return null;
                  } catch {
                    return "The reply could not be sent. Check your connection and try again.";
                  }
                }}
              />
            )}
            <div
              className={`ui-ask-head ${showProposal || result ? "" : "is-lead"}`}
            >
              <h2>
                {showProposal || result
                  ? `Ask ${activeAgent.name}`
                  : `What should ${activeAgent.name} do?`}
              </h2>
            </div>
            <form className="ui-ask" onSubmit={(e) => void submitAsk(e)}>
              <label className="sr-only" htmlFor="ask">
                Ask {activeAgent.name}
              </label>
              <Search size={16} />
              <input
                id="ask"
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                placeholder="Find, compare or buy something"
                disabled={busy === "ask"}
              />
              <Button
                type="submit"
                variant="icon"
                aria-label="Send request"
                busy={busy === "ask"}
                disabled={!!busy || !ask.trim()}
              >
                <ArrowUp size={16} />
              </Button>
            </form>
            <div className="ui-chips">
              {suggestionsFor(activeAgent, state).map((sample) => (
                <LinkButton
                  key={sample.id}
                  onClick={() => void submitAsk(undefined, sample)}
                  disabled={!!busy}
                >
                  {sample.label}
                </LinkButton>
              ))}
            </div>
            {!state.configuration.model && (
              <p className="ui-note">
                No model is connected, so typed requests will not work here. The
                suggestions above still work.
              </p>
            )}
            {busy === "ask" && (
              <p className="ui-note" role="status">
                <LoaderCircle size={14} className="spin" />
                Checking your services and their terms
              </p>
            )}
            {result?.type === "market" &&
              result.market &&
              !priorityProposal && <MarketResults result={result.market} />}
            {market?.status === "searching" && (
              <p className="ui-note" role="status">
                <LoaderCircle size={14} className="spin" />
                Searching the wider market
              </p>
            )}
            {market?.status === "failed" && (
              <p className="ui-note is-danger" role="alert">
                {market.message}
              </p>
            )}
            {market?.status === "found" && (
              <MarketResults result={market.result} />
            )}
            {result?.engine === "fixture" && (
              <p className="ui-note">Scripted sample · no model was called</p>
            )}
            {result?.type === "options" && !priorityProposal && (
              <section>
                <div className="ui-section-head">
                  <h2>{result.title}</h2>
                  <LinkButton onClick={() => setResult(null)}>Close</LinkButton>
                </div>
                <div className="ui-rows">
                  {result.options?.map((option) => (
                    <button
                      key={option.id}
                      className="ui-choice"
                      aria-pressed={selectedOption === option.id}
                      onClick={() => setSelectedOption(option.id)}
                    >
                      <span className="ui-choice-mark" />
                      <span>
                        <span className="ui-row-title">{option.name}</span>
                        <span className="ui-row-detail">
                          {option.terms}
                          {option.kind === "subscription"
                            ? " One month, then cancel."
                            : ""}
                        </span>
                      </span>
                      <span className="ui-choice-price">
                        {money(option.amount)}
                        <small>
                          {option.kind === "subscription"
                            ? " / month"
                            : option.kind === "booking"
                              ? " deposit"
                              : " once"}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="ui-actions">
                  <p className="ui-card-ctx">
                    Your wallet limits apply to every action.
                  </p>
                  <Button
                    variant="primary"
                    busy={busy === "propose"}
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
                              o?.kind === "subscription" ? "subscribe" : "buy",
                          },
                          "propose",
                        );
                    }}
                  >
                    Review proposal
                  </Button>
                </div>
              </section>
            )}
            {result?.type === "answer" && !priorityProposal && (
              <section className="ui-card" aria-label="Answer">
                <div className="ui-card-top">
                  <div>
                    <div className="ui-card-who">From your services</div>
                    <h2 className="ui-card-title">{result.answer}</h2>
                  </div>
                </div>
                {!!result.sources?.length && (
                  <div className="ui-card-body">
                    <p className="ui-note">
                      Sources:
                      {result.sources.map((id) => {
                        const m = state.messages.find((m) => m.id === id);
                        return m ? (
                          <LinkButton
                            key={id}
                            onClick={() => setOpenMessage(m)}
                          >
                            {m.subject}
                          </LinkButton>
                        ) : null;
                      })}
                    </p>
                  </div>
                )}
              </section>
            )}
            <SectionHead title="Services">
              <LinkButton onClick={() => void browse()} disabled={!!busy}>
                Find a service
              </LinkButton>
            </SectionHead>
            {state.wallets.length === 0 ? (
              <div className="ui-rows">
                <div className="ui-empty">
                  <h3>No services yet</h3>
                  <p>
                    Ask for something above or find a service. Its messages,
                    spending and next charge stay together here. Nothing can
                    spend until you choose its permission.
                  </p>
                </div>
              </div>
            ) : (
              <div className="ui-rows">
                {state.wallets.map((wallet) => {
                  const latest = state.proposals.find(
                    (p) => p.wallet_id === wallet.id,
                  );
                  return (
                    <button
                      className="ui-row is-service"
                      key={wallet.id}
                      onClick={() => {
                        setSelectedService(wallet.service_id);
                        setView("messages");
                      }}
                    >
                      <Tile name={wallet.name} />
                      <span>
                        <span className="ui-row-title">{wallet.name}</span>
                        <span className="ui-row-detail">
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
                        </span>
                      </span>
                      <span className="ui-row-detail ui-hide-sm">
                        {latest?.cancel_effective_at
                          ? `Cancels ${date(latest.cancel_effective_at)}`
                          : latest?.status === "WAITING"
                            ? "Watching price"
                            : latest?.status === "RECONCILING"
                              ? "Confirming payment"
                              : "On your request"}
                      </span>
                      <span className="ui-row-num">
                        {money(wallet.spent)} of {money(wallet.cap)} /{" "}
                        {wallet.period}
                        {wallet.reserved > 0 && (
                          <span className="ui-row-detail">
                            {money(wallet.reserved)} reserved
                          </span>
                        )}
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {screen === "activity" && (
          <div className="ui-col">
            {state.wallets.length > 0 && (
              <>
                <SectionHead title="Wallets" />
                <div className="ui-rows">
                  {state.wallets.map((w) => (
                    <div className="ui-row" key={w.id}>
                      <Tile name={w.name} />
                      <span className="ui-row-title">{w.name}</span>
                      <span className="ui-row-num">
                        {money(w.available)} left of {money(w.cap)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <SectionHead title="Activity" />
            <div className="ui-rows">
              {state.audit.length ? (
                state.audit.map((event) => (
                  <div className="ui-row is-plain" key={event.id}>
                    <span>
                      <span className="ui-row-title">
                        {sentenceCase(event.action)}
                      </span>
                      <span className="ui-row-detail">{event.reason}</span>
                    </span>
                    <span className="ui-row-num">
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
                <div className="ui-empty">
                  <h3>No activity yet</h3>
                  <p>
                    Proposals, approvals, declines and payments are recorded
                    here, with the reason for each.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
        {screen === "messages" && (
          <div className="ui-col">
            {!activeAgent && <h1 className="ui-title">Messages</h1>}
            {serviceWallet && (
              <>
                <SectionHead title={serviceWallet.name}>
                  <LinkButton onClick={() => setSelectedService(null)}>
                    Show all messages
                  </LinkButton>
                </SectionHead>
                <div className="ui-toolbar">
                  <span>
                    <strong>{money(serviceWallet.available)}</strong> left ·{" "}
                    {serviceWallet.mode === "draft"
                      ? "Draft only"
                      : serviceWallet.mode === "ask"
                        ? "Ask every time"
                        : "Automatic within limits"}
                  </span>
                  {state.proposals.some(
                    (p) =>
                      p.wallet_id === serviceWallet.id &&
                      p.kind === "subscribe" &&
                      p.status === "PAID",
                  ) && (
                    <LinkButton
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
                    </LinkButton>
                  )}
                  <Button
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
                    )}
                    {serviceWallet.paused
                      ? "Resume spending"
                      : "Pause spending"}
                  </Button>
                  <Button onClick={() => setEditingWallet(serviceWallet.id)}>
                    Wallet rules
                  </Button>
                </div>
              </>
            )}
            <div className="ui-rows is-spaced">
              {filteredMessages.length ? (
                filteredMessages.map((m) => {
                  const owner = workspaceState.agents.findIndex(
                    (agent) => agent.id === m.agent_id,
                  );
                  return (
                    <button
                      key={m.id}
                      className="ui-row is-message"
                      onClick={() => setOpenMessage(m)}
                    >
                      {owner >= 0 ? (
                        <Avatar
                          look={lookFor(workspaceState.agents[owner]!, owner)}
                        />
                      ) : (
                        <Tile name={senderName(m.from)} />
                      )}
                      <span>
                        <span className="ui-row-title">
                          {m.subject}
                          {m.facts.suspicious ? (
                            <Badge tone="danger">Blocked</Badge>
                          ) : isExpiredOffer(m) ? (
                            <Badge>Expired offer</Badge>
                          ) : (
                            <Badge>{sentenceCase(m.kind)}</Badge>
                          )}
                        </span>
                        <span className="ui-row-detail is-clip">
                          {senderName(m.from)} · {m.text.slice(0, 130)}
                        </span>
                      </span>
                      <span className="ui-row-num">
                        {date(m.received_at)}
                        <small>{originLabel(m)}</small>
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="ui-empty">
                  <h3>No messages yet</h3>
                  <p>
                    {activeAgent?.email
                      ? `Messages sent to ${activeAgent.email} appear here once they are delivered.`
                      : activeAgent
                        ? `Create an address for ${activeAgent.name}, then use it for the services you choose. Their messages appear here.`
                        : "Messages your agents receive appear here once they are delivered."}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
        {screen === "inbox" && (
          <div className="ui-col ui-wide">
            <h1 className="ui-title">Before Mailbox</h1>
            <p className="ui-sub">
              The same {state.messages.length} messages in one ordinary inbox,
              with nothing sorted or explained.
            </p>
            <div className="ui-rows is-spaced">
              {state.messages.length ? (
                state.messages.map((m) => (
                  <button
                    key={m.id}
                    className="ui-row is-inbox"
                    onClick={() => setOpenMessage(m)}
                  >
                    <span>{senderName(m.from)}</span>
                    <span className="ui-row-title">{m.subject}</span>
                    <span>{m.text.slice(0, 90)}</span>
                    <span>{date(m.received_at)}</span>
                  </button>
                ))
              ) : (
                <div className="ui-empty">
                  <h3>No messages yet</h3>
                  <p>
                    Open the Demo menu and load sample messages to fill this
                    inbox.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      {openMessage && (
        <Dialog
          title={openMessage.subject}
          onClose={() => setOpenMessage(null)}
        >
          <div className="ui-card-who">{originLabel(openMessage, true)}</div>
          <h2>{openMessage.subject}</h2>
          <p className="ui-sub">
            {senderName(openMessage.from)} · {date(openMessage.received_at)}
          </p>
          {openMessage.facts.suspicious && (
            <p className="ui-note is-danger" role="alert">
              This message tried to change what the agent may do. It was blocked
              and no payment was authorized.
            </p>
          )}
          {openMessage.media?.needs_vision && (
            <p className="ui-note">
              This message has an offer shown only as an image, which has not
              been read yet.
            </p>
          )}
          {openMessage.media?.unread_attachments && (
            <p className="ui-note">
              This message has attachments that have not been read yet.
            </p>
          )}
          <h3 className="ui-table-label">What Mailbox found</h3>
          <dl className="ui-facts">
            <div>
              <dt>Message type</dt>
              <dd>{sentenceCase(openMessage.kind)}</dd>
            </div>
            {openMessage.facts.item && (
              <div>
                <dt>Item</dt>
                <dd>{openMessage.facts.item}</dd>
              </div>
            )}
            {openMessage.facts.amount_minor !== null && (
              <div>
                <dt>Amount in message</dt>
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
            {openMessage.facts.discount_percent !== undefined &&
              openMessage.facts.discount_percent !== null && (
                <div>
                  <dt>Discount</dt>
                  <dd>
                    {openMessage.facts.discount_percent}% immediate discount
                  </dd>
                </div>
              )}
            {openMessage.facts.cashback_percent !== undefined &&
              openMessage.facts.cashback_percent !== null && (
                <div>
                  <dt>Cashback</dt>
                  <dd>
                    {openMessage.facts.cashback_percent}% advertised cashback
                  </dd>
                </div>
              )}
            {openMessage.facts.coupon_code && (
              <div>
                <dt>Code</dt>
                <dd>{openMessage.facts.coupon_code}</dd>
              </div>
            )}
          </dl>
          {(openMessage.facts.coupon_code ||
            (openMessage.facts.discount_percent !== undefined &&
              openMessage.facts.discount_percent !== null)) && (
            <p className="ui-note">
              Cashback is separate from the checkout discount. Eligibility and
              expiry depend on the service terms.
            </p>
          )}
          {openMessage.scenario && (
            <p className="ui-note">Demo variant: {openMessage.scenario}</p>
          )}
          {openMessage.html && (
            <iframe
              className="ui-frame"
              title="Original email preview"
              sandbox=""
              srcDoc={emailFrame + openMessage.html}
            />
          )}
          <details className="ui-details" open={!openMessage.html}>
            <summary>
              {openMessage.html ? "Extracted text" : "Original message"}
            </summary>
            <pre className="ui-pre">{openMessage.text}</pre>
          </details>
        </Dialog>
      )}
      {agentForm && (
        <Dialog
          title={agentForm === "create" ? "New agent" : "Edit agent"}
          onClose={() => setAgentForm(null)}
        >
          <AgentForm
            {...(agentForm !== "create" ? { initial: agentForm } : {})}
            index={
              agentForm === "create"
                ? workspaceState.agents.length
                : workspaceState.agents.findIndex(
                    (agent) => agent.id === agentForm.id,
                  )
            }
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
        </Dialog>
      )}
      {showSdk && (
        <Dialog title="MCP service SDK" onClose={() => setShowSdk(false)}>
          <h2>One service, one configuration</h2>
          <p className="ui-sub">
            The same thin SDK exposes MCP tools, verifies PayPal callbacks and
            produces structured receipts for each sample service.
          </p>
          <pre className="ui-pre is-code">{`createService({
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
          <p className="ui-sub">
            MCP and PayPal are the standards underneath. This shows an
            integration path with invented services; no outside merchant has
            adopted it.
          </p>
        </Dialog>
      )}
      {editedWallet && (
        <Dialog title="Wallet rules" onClose={() => setEditingWallet(null)}>
          <div className="ui-card-who">Wallet rules</div>
          <h2>{editedWallet.name}</h2>
          {editedWallet.status === "revoked" && (
            <p className="ui-sub">
              Payment permission is disconnected.
              {editedWallet.revocation_pending
                ? " Provider cleanup is pending; new spending is already blocked."
                : " A fresh connection is required before this service can spend."}
            </p>
          )}
          <WalletRuleForm
            errorMessage={error}
            key={`${editedWallet.id}:${editedWallet.revision}`}
            wallet={editedWallet}
            busy={!!busy}
            buttonLabel="Save wallet rules"
            onSave={async (rules) => {
              const result = await command(
                { action: "rules", id: editedWallet.id, rules },
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
          {editedWallet.status === "revoked" ? (
            <Button
              className="is-wide"
              disabled={!!busy || editedWallet.revocation_pending}
              onClick={async () => {
                const r = await command(
                  { action: "reconnect", id: editedWallet.id },
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
            </Button>
          ) : (
            <Button
              variant="danger"
              className="is-wide"
              disabled={!!busy}
              onClick={async () => {
                if (
                  !confirm(
                    "Disconnect this service’s payment permission? New spending stops now. Paid access and already dispatched payments may continue.",
                  )
                )
                  return;
                const r = await command(
                  { action: "revoke", id: editedWallet.id },
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
            </Button>
          )}
        </Dialog>
      )}
      {inFlight > 0 && (
        <div className="ui-toast" role="status">
          <LoaderCircle size={14} className="spin" />
          {inFlight} payment{inFlight > 1 ? "s" : ""} awaiting confirmation.
          Reserved funds stay counted.
        </div>
      )}
    </div>
  );
}
