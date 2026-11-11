import fixtures from "../fixtures/emails.json" with { type: "json" };
import { AgentMailClient } from "agentmail";
import { MerchantError } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { Message } from "./app-model.ts";
import { catalogue } from "./catalogue.ts";
import { configured } from "./ai.ts";
import { merchantSender, provisionAddress, syncInbox } from "./email.ts";

export function fixtureMessages(owner: string, now = new Date()): Message[] {
  return fixtures.map((f) => {
    const expires =
      f.expires_days === null
        ? null
        : new Date(now.getTime() + f.expires_days * 86400_000).toISOString();
    return {
      id: `fixture:${owner}:${f.id}`,
      owner,
      service_id: f.service_id,
      provider_id: null,
      subject: f.subject,
      from: f.from,
      text: `${f.text}${expires ? `\nOffer expiry: ${expires}` : ""}\n\nMailbox fixture reference: ${f.id}`,
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
  if (!send) {
    store.setSetting(`message-mode:${owner}`, "preview");
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
  store.setSetting(`message-mode:${owner}`, "live");
  const provider = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY!,
  });
  const sender = await merchantSender(store);
  const ids = [...new Set(messages.map((m) => m.service_id))];
  for (const serviceId of ids) {
    const service = catalogue.services.find((s) => s.id === serviceId)!;
    await provisionAddress(store, store.ensureWallet(owner, service));
  }
  let sent = 0;
  for (const message of messages) {
    const key = `seed-sent:${owner}:${message.id}`,
      existing = store.setting<string>(key);
    if (existing) continue;
    const wallet = store
      .wallets(owner)
      .find((w) => w.service_id === message.service_id)!;
    const response = await provider.inboxes.messages.send(
      sender,
      {
        to: [wallet.email!],
        subject: message.subject,
        text: message.text,
        headers: { "X-Mailbox-Fixture-Id": message.id.split(":").at(-1)! },
      },
      { idempotencyKey: `seed-${owner}-${message.id.split(":").at(-1)}` },
    );
    store.setSetting(key, response.messageId);
    store.setSetting(`seed-provider:${response.messageId}`, message.id);
    sent++;
  }
  for (const wallet of store.wallets(owner)) await syncInbox(store, wallet);
  store.log(
    owner,
    "LIVE_FIXTURES_SENT",
    `${sent} fixture messages sent through the real provider. Only received messages are labeled received.`,
  );
  return { preview: false, sent, total: messages.length };
}
