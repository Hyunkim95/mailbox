export type PermissionMode = "draft" | "ask" | "auto";
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
export type Proposal = {
  id: string;
  owner: string;
  agent_id?: string;
  service_id: string;
  wallet_id: string;
  kind: "subscribe" | "buy" | "book" | "condition";
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
  id: string;
  owner: string;
  agent_id?: string;
  service_id: string;
  provider_id: string | null;
  subject: string;
  from: string;
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
  service_id: string | null;
  action: string;
  reason: string;
  amount: number | null;
  created_at: string;
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
  shared_demo?: boolean;
  agents: PublicAgent[];
  wallets: PublicWallet[];
  proposals: Proposal[];
  messages: Message[];
  audit: Audit[];
  configuration: {
    paypal: boolean;
    email: boolean;
    model: boolean;
    merchant: boolean;
  };
  model_name: string;
  fixture_data: true;
};
