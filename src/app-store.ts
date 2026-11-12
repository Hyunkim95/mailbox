import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Audit,
  Message,
  Proposal,
  PublicWallet,
  Wallet,
  PersonalAgent,
  PublicAgent,
  AgentDocument,
  AgentTask,
  AgentAllowance,
  PublicAgentAllowance,
} from "./app-model.ts";
import type { Service } from "@mailbox/service-sdk";
import { MerchantError } from "@mailbox/service-sdk";
import { encryptToken, decryptToken } from "./token-vault.ts";
import { assertScheduledDispatch } from "./purchase-schedules.ts";

export function periodKey(
  wallet: Pick<Wallet, "period" | "timezone">,
  now = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: wallet.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (key: string) => parts.find((part) => part.type === key)!.value;
  const day = new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00Z`,
  );
  if (wallet.period === "month") return `month:${get("year")}-${get("month")}`;
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return `week:${day.toISOString().slice(0, 10)}`;
}

export class AppStore {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    readonly now: () => Date = () => new Date(),
    readonly vaultSecret: string | undefined = process.env.APP_SESSION_SECRET,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL, agent_id TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, owner TEXT NOT NULL, wallet_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL, provider_id TEXT, body TEXT NOT NULL, UNIQUE(owner,provider_id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,owner TEXT NOT NULL,template TEXT,body TEXT NOT NULL,UNIQUE(owner,template));
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,owner TEXT NOT NULL,agent_id TEXT NOT NULL,body TEXT NOT NULL,content BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS documents_scope ON documents(owner,agent_id);
    `);
    this.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(wallets)").all();
      if (!columns.some((column) => column.name === "agent_id")) {
        this.db.exec(`
          ALTER TABLE wallets RENAME TO wallets_legacy;
          CREATE TABLE wallets(id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL, agent_id TEXT, body TEXT NOT NULL);
          INSERT INTO wallets(id,owner,service_id,agent_id,body)
            SELECT id,owner,service_id,json_extract(body,'$.agent_id'),body FROM wallets_legacy ORDER BY rowid;
          DROP TABLE wallets_legacy;
        `);
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS wallets_agent_service ON wallets(owner,service_id,COALESCE(agent_id,''))",
      );
    });
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  agents(owner: string): PersonalAgent[] {
    return this.db
      .prepare("SELECT body FROM agents WHERE owner=? ORDER BY rowid")
      .all(owner)
      .map((row) => JSON.parse(row.body as string) as PersonalAgent);
  }
  agent(owner: string, id: string): PersonalAgent {
    const row = this.db
      .prepare("SELECT body FROM agents WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row)
      throw new MerchantError("NOT_FOUND", "That agent is not available.");
    return JSON.parse(row.body as string) as PersonalAgent;
  }
  publicAgent(agent: PersonalAgent): PublicAgent {
    const { owner: _owner, inbox_id: _inbox, ...visible } = agent;
    return visible;
  }
  createAgent(
    owner: string,
    input: {
      name: string;
      purpose: string;
      tags?: string[];
      template?: string;
      id?: string;
    },
  ): PersonalAgent {
    const agent: PersonalAgent = {
      id: input.id ?? randomUUID(),
      owner,
      name: input.name,
      purpose: input.purpose,
      tags: input.tags ?? [],
      email: null,
      inbox_id: null,
      template: input.template ?? null,
      status: "draft",
      created_at: this.now().toISOString(),
    };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agents(id,owner,template,body) VALUES(?,?,?,?)",
      )
      .run(agent.id, owner, agent.template, JSON.stringify(agent));
    return agent.template
      ? this.agents(owner).find((a) => a.template === agent.template)!
      : this.agent(owner, agent.id);
  }
  saveAgent(agent: PersonalAgent) {
    this.db
      .prepare("UPDATE agents SET body=? WHERE owner=? AND id=?")
      .run(JSON.stringify(agent), agent.owner, agent.id);
  }
  attachWalletAgent(owner: string, walletId: string, agentId: string): Wallet {
    const agent = this.agent(owner, agentId);
    if (agent.archived_at)
      throw new MerchantError(
        "AGENT_ARCHIVED",
        "This agent is archived. Its connections cannot be reassigned.",
      );
    const wallet = this.wallet(owner, walletId);
    if (wallet.agent_id === agentId) return wallet;
    if (wallet.email && wallet.email !== agent.email)
      throw new MerchantError(
        "SERVICE_ADDRESS_EXISTS",
        "This service already uses a different account address. Manage that connection before changing its agent.",
      );
    if (
      wallet.agent_id &&
      (wallet.vault_id ||
        wallet.email ||
        this.proposals(owner).some(
          (p) =>
            p.wallet_id === walletId &&
            ["PAID", "PAYING", "RECONCILING"].includes(p.status),
        ))
    )
      throw new MerchantError(
        "SERVICE_ALREADY_ASSIGNED",
        "This connected service already belongs to another agent. Open its existing workspace to manage the account.",
      );
    wallet.agent_id = agentId;
    wallet.revision++;
    this.saveWallet(wallet);
    return wallet;
  }
  wallets(owner: string): Wallet[] {
    return this.db
      .prepare("SELECT body FROM wallets WHERE owner=? ORDER BY rowid")
      .all(owner)
      .map((row) => this.readWallet(row.body as string));
  }
  wallet(owner: string, id: string): Wallet {
    const row = this.db
      .prepare("SELECT body FROM wallets WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row)
      throw new MerchantError("NOT_FOUND", "That wallet is not available.");
    return this.readWallet(row.body as string);
  }
  private readWallet(body: string): Wallet {
    const wallet = JSON.parse(body) as Wallet;
    const legacyToken = Boolean(
      wallet.vault_id && !wallet.vault_id.startsWith("enc:v1:"),
    );
    if (wallet.vault_id)
      wallet.vault_id = decryptToken(wallet.vault_id, this.vaultSecret);
    let changed = legacyToken;
    if (!wallet.expires_at) {
      wallet.expires_at = new Date(
        new Date(wallet.created_at).getTime() + 30 * 86400_000,
      ).toISOString();
      changed = true;
    }
    if (
      wallet.pending_reset &&
      periodKey(wallet, this.now()) !== wallet.pending_reset.wait_for_key
    ) {
      wallet.period = wallet.pending_reset.period;
      wallet.timezone = wallet.pending_reset.timezone;
      wallet.revision++;
      delete wallet.pending_reset;
      changed = true;
    }
    if (changed) this.saveWallet(wallet);
    return wallet;
  }
  ensureWallet(owner: string, service: Service, agentId?: string): Wallet {
    if (agentId) {
      const agent = this.agent(owner, agentId);
      if (agent.archived_at)
        throw new MerchantError(
          "AGENT_ARCHIVED",
          "This agent is archived. Its original records remain available, but new service connections are disabled.",
        );
    }
    const existing = this.wallets(owner).find(
      (wallet) =>
        wallet.service_id === service.id && wallet.agent_id === agentId,
    );
    if (existing) return existing;
    const unused =
      agentId &&
      this.wallets(owner).find(
        (wallet) =>
          wallet.service_id === service.id &&
          !wallet.agent_id &&
          !wallet.email &&
          !wallet.inbox_id &&
          !wallet.vault_id &&
          !this.proposals(owner).some((p) => p.wallet_id === wallet.id),
      );
    if (unused) return this.attachWalletAgent(owner, unused.id, agentId);
    const category = service.category;
    const cap =
      category === "entertainment"
        ? 2000
        : category === "groceries"
          ? 15000
          : category === "dining"
            ? 5000
            : 6000;
    const wallet: Wallet = {
      id: randomUUID(),
      owner,
      service_id: service.id,
      ...(agentId ? { agent_id: agentId } : {}),
      name: service.name,
      category,
      cap,
      per_action: cap,
      auto_under: 0,
      daily_limit: 3,
      period:
        category === "groceries" || category === "dining" ? "week" : "month",
      timezone: "Asia/Dubai",
      expires_at: new Date(this.now().getTime() + 30 * 86400_000).toISOString(),
      mode: "draft",
      revision: 1,
      paused: false,
      status: "draft",
      email: null,
      inbox_id: null,
      vault_id: null,
      created_at: this.now().toISOString(),
    };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO wallets(id,owner,service_id,agent_id,body) VALUES(?,?,?,?,?)",
      )
      .run(
        wallet.id,
        owner,
        service.id,
        agentId ?? null,
        JSON.stringify(wallet),
      );
    return this.wallets(owner).find(
      (wallet) =>
        wallet.service_id === service.id && wallet.agent_id === agentId,
    )!;
  }
  saveWallet(wallet: Wallet) {
    this.db
      .prepare("UPDATE wallets SET body=?,agent_id=? WHERE id=? AND owner=?")
      .run(
        JSON.stringify({
          ...wallet,
          vault_id: wallet.vault_id
            ? encryptToken(wallet.vault_id, this.vaultSecret)
            : null,
        }),
        wallet.agent_id ?? null,
        wallet.id,
        wallet.owner,
      );
  }
  proposals(owner: string): Proposal[] {
    return this.db
      .prepare("SELECT body FROM proposals WHERE owner=? ORDER BY rowid DESC")
      .all(owner)
      .map((row) => JSON.parse(row.body as string) as Proposal);
  }
  proposal(owner: string, id: string): Proposal {
    const row = this.db
      .prepare("SELECT body FROM proposals WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row)
      throw new MerchantError("NOT_FOUND", "That proposal is not available.");
    return JSON.parse(row.body as string) as Proposal;
  }
  saveProposal(p: Proposal) {
    p.updated_at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO proposals(id,owner,wallet_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE proposals.owner=excluded.owner",
      )
      .run(p.id, p.owner, p.wallet_id, JSON.stringify(p));
  }
  messages(owner: string, serviceId?: string): Message[] {
    return this.db
      .prepare("SELECT body FROM messages WHERE owner=? ORDER BY rowid DESC")
      .all(owner)
      .map((row) => JSON.parse(row.body as string) as Message)
      .filter((message) => !serviceId || message.service_id === serviceId);
  }
  saveMessage(message: Message) {
    this.db
      .prepare(
        `INSERT INTO messages(id,owner,service_id,provider_id,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,body=excluded.body WHERE messages.owner=excluded.owner AND json_extract(messages.body,'$.origin')='fixture_preview' ON CONFLICT(owner,provider_id) DO NOTHING`,
      )
      .run(
        message.id,
        message.owner,
        message.service_id,
        message.provider_id,
        JSON.stringify(message),
      );
  }
  /** Backfill routing headers once, without rewriting received content or facts. */
  recordReplyRouting(
    owner: string,
    id: string,
    providerId: string,
    replyTo: string[],
  ) {
    return this.transaction(() => {
      const original = this.messages(owner).find((m) => m.id === id);
      if (
        !original ||
        original.origin !== "agentmail" ||
        original.provider_id !== providerId
      )
        throw new MerchantError(
          "SOURCE_MISMATCH",
          "Reply routing must belong to the same received message.",
        );
      if (original.reply_to !== undefined) return original;
      const updated = { ...original, reply_to: [...replyTo] };
      this.db
        .prepare(
          "UPDATE messages SET body=? WHERE id=? AND owner=? AND provider_id=?",
        )
        .run(JSON.stringify(updated), id, owner, providerId);
      return updated;
    });
  }
  /** Received content stays immutable; only verified attachment reading metadata changes. */
  updateAttachmentReadState(
    owner: string,
    id: string,
    attachments: NonNullable<Message["attachments"]>,
  ) {
    const original = this.messages(owner).find((m) => m.id === id);
    if (!original || original.origin !== "agentmail")
      throw new MerchantError(
        "NOT_FOUND",
        "The received source is not available.",
      );
    const combined = new Map(
      (original.attachments ?? []).map((a) => [a.id, a]),
    );
    for (const incoming of attachments) {
      const cached = combined.get(incoming.id);
      // A late failed retry cannot erase an already verified immutable file.
      combined.set(
        incoming.id,
        cached?.read_status === "readable" && cached.document_id
          ? cached
          : incoming,
      );
    }
    const verified = [...combined.values()].map((a) => {
      if (a.document_id) {
        if (!original.agent_id)
          throw new MerchantError(
            "SCOPE_MISMATCH",
            "This source has no agent identity for the document.",
          );
        const doc = this.document(owner, a.document_id, original.agent_id);
        if (doc.message_id !== id)
          throw new MerchantError(
            "SCOPE_MISMATCH",
            "The document belongs to a different source message.",
          );
        return {
          ...a,
          read_status:
            doc.status === "readable"
              ? ("readable" as const)
              : ("unread" as const),
        };
      }
      if (a.read_status === "readable")
        throw new MerchantError(
          "DOCUMENT_UNREAD",
          "A readable document is required before marking an attachment read.",
        );
      return a;
    });
    const updated: Message = {
      ...original,
      attachments: verified,
      media: {
        image_count: original.media?.image_count ?? 0,
        needs_vision: original.media?.needs_vision ?? false,
        unread_attachments: verified.some((a) => a.read_status !== "readable"),
      },
    };
    this.db
      .prepare("UPDATE messages SET body=? WHERE owner=? AND id=?")
      .run(JSON.stringify(updated), owner, id);
    return updated;
  }
  audit(owner: string): Audit[] {
    return this.db
      .prepare(
        "SELECT id,body FROM audit WHERE owner=? ORDER BY id DESC LIMIT 100",
      )
      .all(owner)
      .map((row) => ({
        ...(JSON.parse(row.body as string) as Omit<Audit, "id">),
        id: Number(row.id),
      }));
  }
  log(
    owner: string,
    action: string,
    reason: string,
    serviceId: string | null = null,
    amount: number | null = null,
    agentId?: string,
    runId?: string,
  ) {
    this.db.prepare("INSERT INTO audit(owner,body) VALUES(?,?)").run(
      owner,
      JSON.stringify({
        service_id: serviceId,
        ...(agentId ? { agent_id: agentId } : {}),
        ...(runId ? { run_id: runId } : {}),
        action,
        reason,
        amount,
        created_at: this.now().toISOString(),
      }),
    );
  }
  setting<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT body FROM settings WHERE key=?")
      .get(key);
    return row ? (JSON.parse(row.body as string) as T) : null;
  }
  private agentExposure(owner: string, agentId: string) {
    const wallets = new Map(this.wallets(owner).map((w) => [w.id, w]));
    const actions = this.proposals(owner).filter(
      (p) => (p.agent_id ?? wallets.get(p.wallet_id)?.agent_id) === agentId,
    );
    return {
      spent: actions
        .filter((p) => p.status === "PAID")
        .reduce((sum, p) => sum + p.amount, 0),
      reserved: actions
        .filter((p) => ["PAYING", "RECONCILING"].includes(p.status))
        .reduce((sum, p) => sum + Math.max(p.reserved, p.amount), 0),
    };
  }
  agentAllowance(owner: string, agentId: string): PublicAgentAllowance | null {
    this.agent(owner, agentId);
    const rule = this.setting<AgentAllowance>(
      `agent-allowance:${owner}:${agentId}`,
    );
    if (!rule) return null;
    const exposure = this.agentExposure(owner, agentId),
      expired = new Date(rule.expires_at) <= this.now(),
      remaining = Math.max(0, rule.limit - exposure.spent - exposure.reserved);
    return {
      ...rule,
      ...exposure,
      expired,
      remaining,
      available: rule.paused || expired ? 0 : remaining,
    };
  }
  saveAgentAllowance(
    owner: string,
    agentId: string,
    input: {
      limit: number;
      expires_at: string;
      paused: boolean;
      expected_revision: number | null;
    },
  ) {
    return this.transaction(() => {
      this.agent(owner, agentId);
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 0 ||
        input.limit > 100_000_000 ||
        !Number.isFinite(new Date(input.expires_at).getTime())
      )
        throw new MerchantError(
          "INVALID_ALLOWANCE",
          "Choose a valid total allowance and expiry.",
        );
      const current = this.setting<AgentAllowance>(
        `agent-allowance:${owner}:${agentId}`,
      );
      if ((current?.revision ?? null) !== input.expected_revision)
        throw new MerchantError(
          "RULES_CHANGED",
          "This agent's allowance changed. Reload before saving.",
        );
      const exposure = this.agentExposure(owner, agentId);
      if (input.limit < exposure.spent + exposure.reserved)
        throw new MerchantError(
          "ALLOWANCE_COMMITTED",
          "The limit cannot erase paid or reserved amounts. Pause new payments instead.",
        );
      const rule: AgentAllowance = {
        agent_id: agentId,
        limit: input.limit,
        expires_at: input.expires_at,
        paused: input.paused,
        revision: (current?.revision ?? 0) + 1,
      };
      this.setSetting(`agent-allowance:${owner}:${agentId}`, rule);
      this.log(
        owner,
        "AGENT_ALLOWANCE_SAVED",
        "Total allowance updated. Service permissions still apply separately.",
        null,
        null,
        agentId,
      );
      return this.agentAllowance(owner, agentId)!;
    });
  }
  assertAgentAllowance(
    owner: string,
    agentId: string | undefined,
    amount: number,
  ) {
    if (!agentId) return;
    const allowance = this.agentAllowance(owner, agentId);
    if (!allowance) return;
    if (allowance.paused)
      throw new MerchantError(
        "AGENT_ALLOWANCE_PAUSED",
        "New payments for this agent are paused.",
      );
    if (allowance.expired)
      throw new MerchantError(
        "AGENT_ALLOWANCE_EXPIRED",
        "This agent's total allowance expired. Review its limits before paying.",
      );
    if (amount > allowance.available)
      throw new MerchantError(
        "AGENT_ALLOWANCE",
        "This payment exceeds the remaining total allowance across the agent's services.",
      );
  }
  tasks(owner: string, agentId?: string): AgentTask[] {
    return this.agents(owner)
      .filter((a) => !agentId || a.id === agentId)
      .flatMap((a) =>
        (this.setting<AgentTask[]>(`agent-tasks:${owner}:${a.id}`) ?? []).map(
          (t) => ({ ...t, agent_id: a.id }),
        ),
      );
  }
  documents(owner: string, agentId?: string): AgentDocument[] {
    return this.db
      .prepare(
        `SELECT body FROM documents WHERE owner=?${agentId ? " AND agent_id=?" : ""} ORDER BY rowid`,
      )
      .all(...(agentId ? [owner, agentId] : [owner]))
      .map((r) => JSON.parse(r.body as string) as AgentDocument);
  }
  document(owner: string, id: string, agentId?: string): AgentDocument {
    const doc = this.documents(owner, agentId).find((d) => d.id === id);
    if (!doc)
      throw new MerchantError(
        "NOT_FOUND",
        "That document is not available in this agent's workspace.",
      );
    return doc;
  }
  documentContent(owner: string, id: string): Buffer {
    this.document(owner, id);
    const row = this.db
      .prepare("SELECT content FROM documents WHERE owner=? AND id=?")
      .get(owner, id)!;
    return Buffer.from(row.content as Uint8Array);
  }
  saveDocument(owner: string, document: AgentDocument, content: Uint8Array) {
    this.agent(owner, document.agent_id);
    this.db
      .prepare(
        "INSERT INTO documents(id,owner,agent_id,body,content) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        document.id,
        owner,
        document.agent_id,
        JSON.stringify(document),
        content,
      );
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings(key,body) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body",
      )
      .run(key, JSON.stringify(value));
  }
  deleteSetting(key: string) {
    this.db.prepare("DELETE FROM settings WHERE key=?").run(key);
  }
  createSetup(owner: string, value: unknown): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO setup(id,owner,body) VALUES(?,?,?)")
      .run(id, owner, JSON.stringify(value));
    return id;
  }
  setup<T>(owner: string, id: string): T {
    const row = this.db
      .prepare("SELECT body FROM setup WHERE owner=? AND id=?")
      .get(owner, id);
    if (!row)
      throw new MerchantError(
        "SETUP_NOT_FOUND",
        "Payment setup is missing or expired.",
      );
    return JSON.parse(row.body as string) as T;
  }
  deleteSetup(owner: string, id: string) {
    this.db.prepare("DELETE FROM setup WHERE owner=? AND id=?").run(owner, id);
  }
  publicWallet(owner: string, wallet: Wallet): PublicWallet {
    const key = periodKey(wallet, this.now());
    const proposals = this.proposals(owner).filter(
      (p) => p.wallet_id === wallet.id && p.period_key === key,
    );
    const spent = proposals
      .filter((p) => p.status === "PAID")
      .reduce((sum, p) => sum + p.amount, 0);
    const reserved = proposals.reduce((sum, p) => sum + p.reserved, 0);
    const priorReserved = this.proposals(owner)
      .filter((p) => p.wallet_id === wallet.id && p.period_key !== key)
      .reduce((sum, p) => sum + p.reserved, 0);
    const {
      owner: _owner,
      vault_id: token,
      inbox_id: _inbox,
      ...publicFields
    } = wallet;
    return {
      ...publicFields,
      connected: Boolean(token) && wallet.status !== "revoked",
      revocation_pending: wallet.status === "revoked" && Boolean(token),
      spent,
      reserved,
      prior_reserved: priorReserved,
      available: Math.max(0, wallet.cap - spent - reserved),
    };
  }
  reserve(owner: string, proposalId: string): Proposal {
    return this.transaction(() => {
      const proposal = this.proposal(owner, proposalId),
        wallet = this.wallet(owner, proposal.wallet_id);
      if (
        proposal.status === "PAYING" ||
        proposal.status === "RECONCILING" ||
        proposal.status === "PAID"
      )
        return proposal;
      const deny = (code: string, message: string): never => {
        throw new MerchantError(code, message);
      };
      if (proposal.status !== "APPROVED")
        deny("APPROVAL_REQUIRED", "Approve this exact proposal before paying.");
      if (proposal.kind === "schedule")
        deny(
          "SCHEDULE_ONLY",
          "A monthly rule cannot itself be charged. Only its eligible monthly purchase can be dispatched.",
        );
      assertScheduledDispatch(this, owner, proposal);
      if (wallet.paused || wallet.status === "revoked")
        deny("WALLET_PAUSED", "This service wallet is paused.");
      if (proposal.agent_id && wallet.agent_id !== proposal.agent_id)
        deny(
          "AGENT_CHANGED",
          "The service's agent changed. Review a fresh proposal before paying.",
        );
      if (new Date(wallet.expires_at) <= this.now())
        deny("PERMISSION_EXPIRED", "This service wallet permission expired.");
      if (wallet.mode === "draft")
        deny(
          "DRAFT_ONLY",
          "This wallet is set to draft only. Save a payment permission to continue.",
        );
      if (wallet.revision !== proposal.wallet_revision)
        deny("RULES_CHANGED", "Wallet rules changed. Review a fresh proposal.");
      if (!wallet.vault_id)
        deny("PAYPAL_REQUIRED", "Connect PayPal for this service first.");
      if (
        proposal.kind === "subscribe" &&
        this.proposals(owner).some(
          (other) =>
            other.id !== proposal.id &&
            other.wallet_id === wallet.id &&
            other.kind === "subscribe" &&
            (["PAYING", "RECONCILING"].includes(other.status) ||
              (other.status === "PAID" &&
                (!other.period_end ||
                  new Date(other.period_end) > this.now()) &&
                (!other.cancel_effective_at ||
                  new Date(other.cancel_effective_at) > this.now()))),
        )
      )
        deny(
          "SUBSCRIPTION_EXISTS",
          "You already have access or a payment awaiting confirmation for this service. No second subscription charge was sent.",
        );
      if (
        !proposal.quote_expires ||
        new Date(proposal.quote_expires) <= this.now()
      )
        deny("QUOTE_EXPIRED", "This price expired. Ask for a fresh proposal.");
      if (proposal.amount > wallet.per_action)
        deny("ACTION_LIMIT", "This action exceeds the per-action limit.");
      this.assertAgentAllowance(
        owner,
        proposal.agent_id ?? wallet.agent_id,
        proposal.amount,
      );
      const balance = this.publicWallet(owner, wallet);
      if (proposal.amount > balance.available)
        deny(
          "PERIOD_BUDGET",
          "This service wallet does not have enough remaining budget.",
        );
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: wallet.timezone,
      }).format(this.now());
      const count = this.proposals(owner).filter(
        (p) =>
          p.wallet_id === wallet.id &&
          ["PAID", "PAYING", "RECONCILING"].includes(p.status) &&
          new Intl.DateTimeFormat("en-CA", {
            timeZone: wallet.timezone,
          }).format(new Date(p.dispatched_at ?? p.created_at)) === today,
      ).length;
      if (count >= wallet.daily_limit)
        deny("DAILY_LIMIT", "This wallet reached its daily action limit.");
      proposal.status = "PAYING";
      proposal.dispatched_at ??= this.now().toISOString();
      proposal.reserved = proposal.amount;
      proposal.period_key = periodKey(wallet, this.now());
      this.saveProposal(proposal);
      this.log(
        owner,
        "PAYMENT_RESERVED",
        "Wallet limits checked before dispatch.",
        wallet.service_id,
        proposal.amount,
      );
      return proposal;
    });
  }
}
