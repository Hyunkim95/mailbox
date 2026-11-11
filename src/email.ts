import { AgentMailClient } from "agentmail";
import { randomUUID } from "node:crypto";
import { MerchantError } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Wallet } from "./app-model.ts";
import { configured, extractEmail } from "./ai.ts";
import { readEmailContent } from "./email-content.ts";

function client() {
  if (!configured("AGENTMAIL_API_KEY"))
    throw new MerchantError(
      "EMAIL_NOT_CONFIGURED",
      "Add the email API key to create service addresses.",
    );
  return new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
}
export async function provisionAddress(store: AppStore, wallet: Wallet) {
  if (wallet.inbox_id && wallet.email) return wallet;
  const inbox = await client().inboxes.create({
    username: `mb-${wallet.owner.slice(0, 8)}-${wallet.service_id}`,
    displayName: `Maya · ${wallet.name}`,
    clientId: `${wallet.owner}:${wallet.service_id}`,
  });
  wallet = store.wallet(wallet.owner, wallet.id);
  wallet.inbox_id = inbox.inboxId;
  wallet.email = inbox.email;
  store.saveWallet(wallet);
  store.log(
    wallet.owner,
    "ADDRESS_CREATED",
    "Dedicated service address created.",
    wallet.service_id,
  );
  return wallet;
}
export async function merchantSender(store: AppStore) {
  const existing = store.setting<string>("merchant_sender");
  if (existing) return existing;
  const inbox = await client().inboxes.create({
    displayName: "Mailbox Fixture Merchant",
    clientId: "mailbox-fixture-merchant",
  });
  store.setSetting("merchant_sender", inbox.inboxId);
  return inbox.inboxId;
}
export async function syncInbox(store: AppStore, wallet: Wallet) {
  if (!wallet.inbox_id || !configured("AGENTMAIL_API_KEY")) return;
  const provider = client();
  const result = await provider.inboxes.messages.list(wallet.inbox_id, {
    limit: 50,
  });
  const known = new Set(
    store
      .messages(wallet.owner, wallet.service_id)
      .filter((m) => m.provider_id)
      .map((m) => m.provider_id),
  );
  for (const item of [...result.messages].reverse()) {
    if (known.has(item.messageId)) continue;
    const message = await provider.inboxes.messages.get(
      wallet.inbox_id,
      item.messageId,
    );
    const content = readEmailContent({
      text: message.extractedText || message.text,
      html: message.html,
      preview: message.preview,
    });
    const text = content.text;
    const facts = await extractEmail(message.subject ?? "", text);
    store.saveMessage({
      id:
        store.setting<string>(`seed-provider:${message.messageId}`) ??
        randomUUID(),
      owner: wallet.owner,
      service_id: wallet.service_id,
      provider_id: message.messageId,
      subject: message.subject ?? "Service message",
      from: message.from,
      text,
      received_at: new Date(message.timestamp).toISOString(),
      kind: facts.kind,
      facts: {
        item: facts.item,
        amount_minor: facts.amount_minor,
        expires: facts.expires,
        action_id: facts.action_id,
        suspicious: facts.suspicious,
        coupon_code: facts.coupon_code,
        discount_percent: facts.discount_percent,
        cashback_percent: facts.cashback_percent,
        date_hint: facts.date_hint,
      },
      origin: "agentmail",
      media: {
        image_count: content.images.length,
        needs_vision: content.needsVision,
        unread_attachments: Boolean(message.attachments?.length),
      },
    });
    if (facts.suspicious)
      store.log(
        wallet.owner,
        "EMAIL_QUARANTINED",
        "Email attempted an unsupported or permission-changing action. No spending authority granted.",
        wallet.service_id,
      );
    else if (/upgrade|upsell|more screens/i.test(message.subject ?? ""))
      store.log(
        wallet.owner,
        "UPGRADE_DECLINED",
        "An unrequested upgrade cannot create spending authority. No payment or interruption was needed.",
        wallet.service_id,
        facts.amount_minor,
      );
  }
}
export async function deliverOutbox(store: AppStore) {
  if (!configured("AGENTMAIL_API_KEY")) return;
  const token = process.env.MOCK_ADMIN_TOKEN,
    base =
      process.env.MOCK_MERCHANT_URL ??
      `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  if (!token) return;
  const response = await fetch(`${base}/internal/outbox`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new MerchantError(
      "OUTBOX_UNAVAILABLE",
      "Could not retrieve merchant confirmations.",
    );
  const { emails } = (await response.json()) as {
    emails: {
      id: string;
      to: string;
      subject: string;
      text: string;
      provider_message_id: string | null;
    }[];
  };
  const sender = emails.some((e) => !e.provider_message_id)
    ? await merchantSender(store)
    : null;
  for (const email of emails) {
    if (email.provider_message_id || !sender) continue;
    const key = `email-send:${email.id}`;
    let receipt = store.setting<string>(key);
    if (!receipt) {
      const sent = await client().inboxes.messages.send(
        sender,
        { to: [email.to], subject: email.subject, text: email.text },
        { idempotencyKey: `mailbox-${email.id}` },
      );
      receipt = sent.messageId;
      store.setSetting(key, receipt);
    }
    const ack = await fetch(`${base}/internal/outbox/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: email.id, provider_message_id: receipt }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!ack.ok)
      throw new MerchantError(
        "EMAIL_ACK_PENDING",
        "Email was sent; merchant acknowledgment will be retried.",
      );
  }
}
