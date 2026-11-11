import fixtures from "../fixtures/emails.json" with { type: "json" };
import { AgentMailClient } from "agentmail";
import { MerchantError } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Message } from "./app-model.ts";
import { catalogue } from "./catalogue.ts";
import { configured } from "./ai.ts";
import { merchantSender, syncAgentInbox } from "./email.ts";
import { nativePromotionFacts, readEmailContent } from "./email-content.ts";
import { sampleAgents, defaultAgent } from "./agents.ts";

export function fixtureMessages(owner: string, now = new Date()): Message[] {
  return fixtures.map((f) => {
    const expires =
      f.expires_days === null
        ? null
        : new Date(now.getTime() + f.expires_days * 86400_000).toISOString();
    const html = "html" in f && typeof f.html === "string" ? f.html : undefined;
    const content = readEmailContent({
      text: f.text,
      ...(html ? { html } : {}),
    });
    return {
      id: `fixture:${owner}:${f.id}`,
      owner,
      service_id: f.service_id,
      provider_id: null,
      subject: f.subject,
      from: f.from,
      text: `${content.text}${expires ? `\nOffer expiry: ${expires}` : ""}\n\nMailbox fixture reference: ${f.id}`,
      scenario: f.scenario,
      format: html ? "html" : "plain_text",
      ...(html ? { html } : {}),
      media: {
        image_count: content.images.length,
        needs_vision: content.needsVision,
        unread_attachments: false,
      },
      received_at: new Date(
        now.getTime() - f.days_ago * 86400_000,
      ).toISOString(),
      kind: f.kind as Message["kind"],
      facts: {
        item: f.item,
        amount_minor: f.amount_minor,
        expires,
        action_id: null,
        suspicious: f.id === "pets-06",
        ...nativePromotionFacts(f.subject, content.text),
      },
      origin: "fixture_preview",
    };
  });
}
export async function seedMessages(
  store: AppStore,
  owner: string,
  send: boolean,
) {
  const messages = fixtureMessages(owner, store.now());
  sampleAgents(store, owner);
  for (const message of messages) {
    const service = catalogue.services.find(
      (service) => service.id === message.service_id,
    )!;
    message.agent_id =
      store.wallets(owner).find((wallet) => wallet.service_id === service.id)
        ?.agent_id ?? defaultAgent(store, owner, service).id;
  }
  if (!send) {
    for (const message of messages) store.saveMessage(message);
    store.log(
      owner,
      "FIXTURE_PREVIEW_LOADED",
      "24 preview messages loaded from the committed fixture files. No email delivery or payment claimed.",
    );
    return { preview: true, count: messages.length };
  }
  if (!configured("AGENTMAIL_API_KEY"))
    throw new MerchantError(
      "EMAIL_NOT_CONFIGURED",
      "Add the email API key before sending the live seed.",
    );
  const connected = new Map(
    store
      .agents(owner)
      .filter((agent) => agent.email && agent.inbox_id)
      .map((agent) => [agent.id, agent]),
  );
  const deliverable = messages.filter((message) =>
    connected.has(message.agent_id!),
  );
  if (!deliverable.length)
    throw new MerchantError(
      "EMAIL_ADDRESS_REQUIRED",
      "Create an agent address before sending sample emails. Other agents keep their labeled previews.",
    );
  const provider = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY!,
  });
  const sender = await merchantSender(store);
  let sent = 0;
  for (const message of deliverable) {
    const key = `seed-sent:${owner}:${message.id}`,
      existing = store.setting<string>(key);
    if (existing) continue;
    const agent = connected.get(message.agent_id!)!;
    const response = await provider.inboxes.messages.send(
      sender,
      {
        to: [agent.email!],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        headers: { "X-Mailbox-Fixture-Id": message.id.split(":").at(-1)! },
      },
      { idempotencyKey: `seed-${owner}-${message.id.split(":").at(-1)}` },
    );
    store.setSetting(key, response.messageId);
    store.setSetting(`seed-provider:${response.messageId}`, message.id);
    if (message.scenario)
      store.setSetting(`seed-scenario:${response.messageId}`, message.scenario);
    sent++;
  }
  for (const agent of connected.values()) await syncAgentInbox(store, agent);
  store.log(
    owner,
    "LIVE_FIXTURES_SENT",
    `${sent} sample emails sent to connected agents. Other agents keep their labeled previews. Only received messages are labeled received.`,
  );
  return {
    preview: false,
    sent,
    total: deliverable.length,
    preview_retained: messages.length - deliverable.length,
  };
}
