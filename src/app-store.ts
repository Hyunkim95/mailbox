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
} from "./app-model.ts";
import type { Service } from "@mailbox/service-sdk";
import { MerchantError } from "@mailbox/service-sdk";
import { encryptToken, decryptToken } from "./token-vault.ts";

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
      CREATE TABLE IF NOT EXISTS wallets(id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,service_id));
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, owner TEXT NOT NULL, wallet_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, owner TEXT NOT NULL, service_id TEXT NOT NULL, provider_id TEXT, body TEXT NOT NULL, UNIQUE(owner,provider_id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
    `);
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
  ensureWallet(owner: string, service: Service): Wallet {
    const existing = this.wallets(owner).find(
      (wallet) => wallet.service_id === service.id,
    );
    if (existing) return existing;
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
        "INSERT OR IGNORE INTO wallets(id,owner,service_id,body) VALUES(?,?,?,?)",
      )
      .run(wallet.id, owner, service.id, JSON.stringify(wallet));
    return this.wallets(owner).find(
      (wallet) => wallet.service_id === service.id,
    )!;
  }
  saveWallet(wallet: Wallet) {
    this.db.prepare("UPDATE wallets SET body=? WHERE id=? AND owner=?").run(
      JSON.stringify({
        ...wallet,
        vault_id: wallet.vault_id
          ? encryptToken(wallet.vault_id, this.vaultSecret)
          : null,
      }),
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
      .filter(
        (message) =>
          (!serviceId || message.service_id === serviceId) &&
          (this.setting<string>(`message-mode:${owner}`) !== "live" ||
            message.origin === "agentmail"),
      );
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
  ) {
    this.db.prepare("INSERT INTO audit(owner,body) VALUES(?,?)").run(
      owner,
      JSON.stringify({
        service_id: serviceId,
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
      if (wallet.paused || wallet.status === "revoked")
        deny("WALLET_PAUSED", "This service wallet is paused.");
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
