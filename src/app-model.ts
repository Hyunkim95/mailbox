export type PermissionMode = "draft" | "ask" | "auto";
export type AgentAllowance = {
  agent_id: string;
  limit: number;
  expires_at: string;
  paused: boolean;
  revision: number;
};
export type PublicAgentAllowance = AgentAllowance & {
  spent: number;
  reserved: number;
  remaining: number;
  available: number;
  expired: boolean;
};
/** How an agent's drawn face looks. Each field is an index into the avatar's options. */
export type AgentLook = {
  hair: number;
  eyes: number;
  mouth: number;
  color: number;
};
export type PersonalAgent = {
  id: string;
  owner: string;
  name: string;
  purpose: string;
  tags: string[];
  email: string | null;
  inbox_id: string | null;
  template: string | null;
  status: "draft" | "connected" | "paused";
  /** Retired identity; original address and records are preserved for history. */
  archived_at?: string;
  /** Chosen by the owner. Without it the face is derived from the agent id. */
  look?: AgentLook;
  created_at: string;
};
export type PublicAgent = Omit<PersonalAgent, "owner" | "inbox_id">;
export type Wallet = {
  id: string;
  owner: string;
  service_id: string;
  agent_id?: string;
  name: string;
  category: string;
  cap: number;
  per_action: number;
  auto_under: number;
  daily_limit: number;
  period: "week" | "month";
  timezone: string;
  expires_at: string;
  pending_reset?: {
    period: "week" | "month";
    timezone: string;
    wait_for_key: string;
  };
  mode: PermissionMode;
  revision: number;
  paused: boolean;
  status: "draft" | "ready" | "active" | "canceled" | "revoked";
  email: string | null;
  inbox_id: string | null;
  vault_id: string | null;
  created_at: string;
};
export type MonthlyPurchaseRule = {
  timezone: string;
  day_of_month: number;
  local_time: string;
  starts_at: string;
  expires_at: string;
  max_amount_minor: number;
  price_inclusive: boolean;
  item: {
    name: string;
    terms: string;
    unit?: "g" | "ml" | "each";
    unit_quantity?: number;
    comparison_group?: string;
  };
  approved_at: string | null;
};
export type Proposal = {
  /** Verified history, linked without transferring its payment authority. */
  history_source?: {
    base_url: string;
    owner_id: string;
    wallet_id: string;
    imported_at: string;
  };
  owner_request?: string;
  id: string;
  owner: string;
  agent_id?: string;
  service_id: string;
  wallet_id: string;
  kind: "subscribe" | "buy" | "book" | "condition" | "schedule";
  monthly_schedule?: MonthlyPurchaseRule;
  scheduled_by?: { proposal_id: string; period: string };
  next_scheduled_at?: string | null;
  latest_scheduled_purchase?: {
    id: string;
    status: Proposal["status"];
    amount: number;
    period: string;
    capture_id: string | null;
  };
  title: string;
  rationale: string;
  amount: number;
  quantity: number;
  item_id: string;
  quote_id: string | null;
  quote_expires: string | null;
  wallet_revision: number;
  merchant_action_id: string | null;
  status:
    | "DRAFT"
    | "NEEDS_APPROVAL"
    | "APPROVED"
    | "WAITING"
    | "PAYING"
    | "PAID"
    | "RECONCILING"
    | "DECLINED"
    | "BLOCKED"
    | "EXPIRED";
  reason: string | null;
  reserved: number;
  period_key: string | null;
  paypal_order_id: string | null;
  capture_id: string | null;
  booking: { date: string; time: string; party_size: number } | null;
  condition_under: number | null;
  condition_expires: string | null;
  period_end: string | null;
  cancel_effective_at: string | null;
  sources: string[];
  created_at: string;
  updated_at: string;
  dispatched_at?: string;
  comparison?: {
    rows: {
      service_id: string;
      item_id: string;
      label: string;
      pack: string;
      amount: number;
      unit_price: number;
      unit_label: string;
      source_ids: string[];
      eligible: boolean;
    }[];
    selected_item_id: string;
    selected_service_id: string;
    expired_offers: number;
    checked_at: string;
    scope: string;
  };
};
export type Message = {
  attachments?: {
    id: string;
    filename: string;
    content_type: string;
    size: number;
    read_status?: "readable" | "unread" | "retry";
    document_id?: string;
  }[];
  id: string;
  owner: string;
  agent_id?: string;
  service_id: string;
  provider_id: string | null;
  subject: string;
  from: string;
  /** Provider-verified Reply-To header; [] means the original had none. */
  reply_to?: string[];
  recipients?: string[];
  text: string;
  received_at: string;
  kind:
    | "offer"
    | "receipt"
    | "invoice"
    | "renewal"
    | "confirmation"
    | "verification"
    | "other";
  scenario?: string;
  format?: "plain_text" | "html";
  html?: string;
  facts: {
    item: string | null;
    amount_minor: number | null;
    currency?: string | null;
    expires: string | null;
    action_id: string | null;
    suspicious: boolean;
    coupon_code?: string | null;
    discount_percent?: number | null;
    cashback_percent?: number | null;
    date_hint?: string | null;
  };
  origin: "fixture_preview" | "agentmail";
  media?: {
    image_count: number;
    needs_vision: boolean;
    unread_attachments: boolean;
  };
};
export type Audit = {
  id: number;
  agent_id?: string;
  run_id?: string;
  service_id: string | null;
  action: string;
  reason: string;
  amount: number | null;
  created_at: string;
};
export type AgentTask = {
  id: string;
  agent_id: string;
  text: string;
  status: "todo" | "blocked" | "ready";
  sources: string[];
  note: string;
  updated_at: string;
};
export type PreparedReply = {
  id?: string;
  message_id: string;
  service_id: string;
  to_name: string;
  to_address?: string;
  subject: string;
  body: string;
  sources?: string[];
  documents?: { id: string; filename: string }[];
};
export type CancellationReview = {
  id: string;
  owner: string;
  agent_id: string;
  revision: number;
  effective: "immediate" | "period_end";
  status: "DRAFT" | "RUNNING" | "COMPLETE" | "PARTIAL" | "DISCARDED";
  confirmed_at: string | null;
  created_at: string;
  entries: {
    proposal_id: string;
    wallet_id: string;
    merchant_action_id: string;
    service_id: string;
    title: string;
    amount: number;
    period_end: string | null;
    renewal_already_disabled: boolean;
    status: "PENDING" | "ENDED" | "SCHEDULED" | "NEEDS_REVIEW";
    effective_at: string | null;
    reason: string | null;
  }[];
  delivery_pending?: boolean;
};
export type AgentDocument = {
  id: string;
  agent_id: string;
  message_id: string | null;
  filename: string;
  content_type: string;
  size: number;
  text: string;
  truncated: boolean;
  status: "readable" | "unread";
  limitation: string | null;
  created_at: string;
  origin: "upload" | "agentmail" | "fixture_preview";
};
export type PublicWallet = Omit<Wallet, "owner" | "vault_id" | "inbox_id"> & {
  connected: boolean;
  revocation_pending: boolean;
  spent: number;
  reserved: number;
  prior_reserved: number;
  available: number;
};
export type AppState = {
  now?: string;
  agent_allowances?: PublicAgentAllowance[];
  cancellation_reviews?: Omit<CancellationReview, "owner">[];
  reply_drafts?: { agent_id: string; draft: PreparedReply }[];
  tasks?: AgentTask[];
  documents?: Omit<AgentDocument, "text">[];
  shared_demo?: boolean;
  agents: PublicAgent[];
  wallets: PublicWallet[];
  proposals: Proposal[];
  messages: Message[];
  /** Ids of messages the owner dismissed from the "needs you" queue. */
  dismissed: string[];
  audit: Audit[];
  configuration: {
    paypal: boolean;
    email: boolean;
    email_preview?: boolean;
    model: boolean;
    merchant: boolean;
  };
  model_name: string;
  fixture_data: true;
};
