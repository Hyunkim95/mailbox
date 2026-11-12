import { AgentMailClient, AgentMailError } from "agentmail";
import { randomUUID, createHash } from "node:crypto";
import fixtureEmails from "../fixtures/emails.json" with { type: "json" };
import { MerchantError, type OutboundEmail } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Wallet, PersonalAgent, Message } from "./app-model.ts";
import { defaultAgent } from "./agents.ts";
import { catalogue } from "./catalogue.ts";
import { configured, extractEmail } from "./ai.ts";
import { readEmailContent } from "./email-content.ts";
import { replyAddresses } from "./reply-routing.ts";
import {
  importDocument,
  readBoundedBody,
  MAX_DOCUMENT_BYTES,
} from "./documents.ts";

function client() {
  if (!configured("AGENTMAIL_API_KEY"))
    throw new MerchantError(
      "EMAIL_NOT_CONFIGURED",
      "Add the email API key to create service addresses.",
    );
  return new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
}
function providerFailure(error: unknown): never {
  if (
    error instanceof AgentMailError &&
    error.body &&
    typeof error.body === "object" &&
    "code" in error.body &&
    error.body.code === "limit_exceeded"
  )
    throw new MerchantError(
      "EMAIL_INBOX_LIMIT",
      "The email provider’s inbox limit has been reached. Existing mail and labeled previews are kept. Reuse an existing agent address or increase your provider inbox capacity.",
    );
  throw error;
}
export async function provisionAddress(store: AppStore, wallet: Wallet) {
  if (wallet.inbox_id && wallet.email) return wallet;
  const agent = wallet.agent_id
    ? store.agent(wallet.owner, wallet.agent_id)
    : defaultAgent(
        store,
        wallet.owner,
        catalogue.services.find((service) => service.id === wallet.service_id)!,
      );
  const connected = await provisionAgentAddress(store, agent);
  wallet = store.wallet(wallet.owner, wallet.id);
  if (wallet.agent_id && wallet.agent_id !== connected.id)
    throw new MerchantError(
      "AGENT_CHANGED",
      "The selected agent changed while its address was being prepared. Review a fresh proposal.",
    );
  wallet.agent_id = connected.id;
  wallet.inbox_id = connected.inbox_id;
  wallet.email = connected.email;
  store.saveWallet(wallet);
  return wallet;
}
export async function provisionAgentAddress(
  store: AppStore,
  agent: PersonalAgent,
): Promise<PersonalAgent> {
  if (agent.archived_at)
    throw new MerchantError(
      "AGENT_ARCHIVED",
      "This agent is archived. Create a new agent to receive a new address.",
    );
  if (agent.inbox_id && agent.email) return agent;
  const slug =
    agent.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "agent";
  const inbox = await client()
    .inboxes.create({
      username: `${slug}-${agent.id.slice(0, 8)}`,
      displayName: agent.name,
      clientId: agent.id,
    })
    .catch(providerFailure);
  agent = store.agent(agent.owner, agent.id);
  agent.inbox_id = inbox.inboxId;
  agent.email = inbox.email;
  agent.status = "connected";
  store.saveAgent(agent);
  store.log(
    agent.owner,
    "ADDRESS_CREATED",
    "Agent address created for reuse across user-selected service signups.",
  );
  return agent;
}
export async function merchantSender(store: AppStore) {
  const existing = store.setting<string>("merchant_sender");
  if (existing) return existing;
  const inbox = await client()
    .inboxes.create({
      displayName: "Mailbox Fixture Merchant",
      clientId: "mailbox-fixture-merchant",
    })
    .catch(providerFailure);
  store.setSetting("merchant_sender", inbox.inboxId);
  return inbox.inboxId;
}
export async function syncInbox(store: AppStore, wallet: Wallet) {
  return syncMailbox(store, {
    owner: wallet.owner,
    inbox_id: wallet.inbox_id,
    ...(wallet.agent_id ? { agent_id: wallet.agent_id } : {}),
    ...(!wallet.agent_id ? { legacy_service_id: wallet.service_id } : {}),
  });
}
export async function syncAgentInbox(store: AppStore, agent: PersonalAgent) {
  return syncMailbox(store, {
    owner: agent.owner,
    inbox_id: agent.inbox_id,
    agent_id: agent.id,
  });
}
export function incomingService(
  text: string,
  sender: string,
  legacyServiceId?: string,
  assignedServices: { id: string; name: string }[] = [],
) {
  const knownServices = [...catalogue.services, ...assignedServices];
  const fixtureId = /Mailbox fixture reference:\s*([a-z0-9-]+)/i.exec(
    text,
  )?.[1];
  const fixture = fixtureEmails.find((f) => f.id === fixtureId);
  if (fixture) return { service_id: fixture.service_id, fixture };
  const marker =
    /--- mailbox\.service-event\.v1 ---\s*([\s\S]*?)\s*--- end mailbox\.service-event\.v1 ---/.exec(
      text,
    );
  if (marker)
    try {
      const event = JSON.parse(marker[1]!);
      if (knownServices.some((service) => service.id === event.service_id))
        return { service_id: event.service_id as string };
    } catch {}
  const normalized = sender.toLowerCase().replace(/[^a-z0-9]/g, "");
  const services = [
    ...new Map(knownServices.map((s) => [s.id, s])).values(),
  ].filter((service) =>
    normalized.includes(service.name.toLowerCase().replace(/[^a-z0-9]/g, "")),
  );
  return {
    service_id:
      services.length === 1
        ? services[0]!.id
        : (legacyServiceId ??
          `email:${createHash("sha256").update(sender.toLowerCase()).digest("hex").slice(0, 16)}`),
  };
}
async function syncMailbox(
  store: AppStore,
  wallet: {
    owner: string;
    inbox_id: string | null;
    agent_id?: string;
    legacy_service_id?: string;
  },
) {
  if (!wallet.inbox_id || !configured("AGENTMAIL_API_KEY")) return;
  const provider = client();
  const result = await provider.inboxes.messages.list(wallet.inbox_id, {
    limit: 50,
  });
  const known = new Map(
    store
      .messages(wallet.owner)
      .filter((message) =>
        wallet.agent_id
          ? message.agent_id === wallet.agent_id
          : message.service_id === wallet.legacy_service_id,
      )
      .filter((m) => m.provider_id)
      .map((m) => [m.provider_id, m] as const),
  );
  for (const item of [...result.messages].reverse()) {
    const providerId = `${wallet.inbox_id}:${item.messageId}`;
    const previous = known.get(providerId) ?? known.get(item.messageId);
    const retryAttachments =
      previous &&
      (previous.attachments?.some(
        (a) => !a.read_status || a.read_status === "retry",
      ) ||
        (previous.media?.unread_attachments && !previous.attachments?.length));
    if (previous && !retryAttachments && previous.reply_to !== undefined)
      continue;
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
    const identified = incomingService(
      text,
      message.from,
      wallet.legacy_service_id,
      store
        .wallets(wallet.owner)
        .filter((w) =>
          wallet.agent_id
            ? w.agent_id === wallet.agent_id
            : w.service_id === wallet.legacy_service_id,
        )
        .map((w) => ({ id: w.service_id, name: w.name })),
    );
    const saved: Message = {
      id:
        previous?.id ??
        store.setting<string>(`seed-provider:${message.messageId}`) ??
        (identified.fixture
          ? `fixture:${wallet.owner}:${identified.fixture.id}`
          : randomUUID()),
      owner: wallet.owner,
      service_id: identified.service_id,
      ...(wallet.agent_id ? { agent_id: wallet.agent_id } : {}),
      provider_id: providerId,
      subject: message.subject ?? "Service message",
      from: message.from,
      reply_to: message.replyTo ?? [],
      recipients: message.to,
      text,
      format: message.html ? "html" : "plain_text",
      ...(identified.fixture ? { scenario: identified.fixture.scenario } : {}),
      ...(store.setting<string>(`seed-scenario:${message.messageId}`)
        ? {
            scenario: store.setting<string>(
              `seed-scenario:${message.messageId}`,
            )!,
          }
        : {}),
      ...(message.html ? { html: message.html } : {}),
      received_at: new Date(message.timestamp).toISOString(),
      kind: facts.kind,
      facts: {
        item: facts.item,
        amount_minor: facts.amount_minor,
        currency: facts.currency,
        expires: facts.expires,
        action_id: facts.action_id,
        suspicious: facts.suspicious,
        coupon_code: facts.coupon_code,
        discount_percent: facts.discount_percent,
        cashback_percent: facts.cashback_percent,
        date_hint: facts.date_hint,
      },
      origin: "agentmail",
      attachments: (message.attachments ?? []).map((a) => ({
        id: a.attachmentId,
        filename: a.filename ?? "attachment",
        content_type: a.contentType ?? "application/octet-stream",
        size: a.size,
        read_status: wallet.agent_id ? ("retry" as const) : ("unread" as const),
      })),
      media: {
        image_count: content.images.length,
        needs_vision: content.needsVision,
        unread_attachments: Boolean(message.attachments?.length),
      },
    };
    store.saveMessage(saved);
    if (previous?.provider_id && previous.reply_to === undefined)
      store.recordReplyRouting(
        wallet.owner,
        previous.id,
        previous.provider_id,
        saved.reply_to!,
      );
    if (wallet.agent_id)
      for (const attachment of message.attachments ?? []) {
        const metadata = saved.attachments!.find(
          (a) => a.id === attachment.attachmentId,
        )!;
        const cached = previous?.attachments?.find(
          (a) => a.id === attachment.attachmentId,
        );
        if (cached?.read_status && cached.read_status !== "retry") {
          Object.assign(metadata, cached);
          continue;
        }
        if (attachment.size > MAX_DOCUMENT_BYTES) {
          metadata.read_status = "unread";
          continue;
        }
        try {
          const info = await provider.inboxes.messages.getAttachment(
            wallet.inbox_id,
            message.messageId,
            attachment.attachmentId,
          );
          const url = new URL(info.downloadUrl);
          if (url.protocol !== "https:" || url.username || url.password)
            throw Error("Invalid attachment download");
          const download = await fetch(url, {
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!download.ok) throw Error("Attachment unavailable");
          const doc = await importDocument(
            store,
            wallet.owner,
            wallet.agent_id,
            {
              filename: attachment.filename ?? "attachment",
              content_type:
                attachment.contentType ?? "application/octet-stream",
              bytes: await readBoundedBody(download.body),
              message_id: saved.id,
              origin: "agentmail",
            },
          );
          metadata.read_status =
            doc.status === "readable" ? "readable" : "unread";
          metadata.document_id = doc.id;
        } catch {
          store.log(
            wallet.owner,
            "DOCUMENT_UNREAD",
            "An email attachment could not be read. It remains missing evidence.",
            identified.service_id,
            null,
            wallet.agent_id,
          );
        }
      }
    saved.media!.unread_attachments = Boolean(
      saved.attachments?.some((a) => a.read_status !== "readable"),
    );
    const updated = store.updateAttachmentReadState(
      wallet.owner,
      saved.id,
      saved.attachments ?? [],
    );
    known.set(providerId, updated);
    if (facts.suspicious)
      store.log(
        wallet.owner,
        "EMAIL_QUARANTINED",
        "Email attempted an unsupported or permission-changing action. No spending authority granted.",
        identified.service_id,
      );
    else if (/upgrade|upsell|more screens/i.test(message.subject ?? ""))
      store.log(
        wallet.owner,
        "UPGRADE_DECLINED",
        "An unrequested upgrade cannot create spending authority. No payment or interruption was needed.",
        identified.service_id,
        facts.amount_minor,
      );
  }
}
/** Sends the owner-approved reply from the agent's own inbox, once per key. */
export async function sendAgentReply(
  agent: PersonalAgent,
  message: Message,
  text: string,
  idempotencyKey: string,
  attachments: {
    filename: string;
    contentType: string;
    content: string;
  }[] = [],
): Promise<string> {
  const inbox = agent.inbox_id!;
  const reference = message.provider_id!;
  const messageId = reference.startsWith(`${inbox}:`)
    ? reference.slice(inbox.length + 1)
    : reference;
  const sent = await client().inboxes.messages.reply(
    inbox,
    messageId,
    {
      text,
      to: replyAddresses(message),
      ...(attachments.length ? { attachments } : {}),
    },
    { idempotencyKey: `mailbox-reply-${idempotencyKey}` },
  );
  return sent.messageId;
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
    emails: OutboundEmail[];
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
        {
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.attachments?.length
            ? {
                attachments: email.attachments.map((a) => ({
                  filename: a.filename,
                  contentType: a.content_type,
                  content: a.content_base64,
                })),
              }
            : {}),
        },
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
