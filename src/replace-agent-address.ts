import { createHash } from "node:crypto";
import { AgentMailClient, AgentMailError } from "agentmail";
import { MerchantError } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";

type InboxProvider = {
  get: (id: string) => Promise<unknown>;
  create: (input: {
    username: string;
    displayName: string;
    clientId: string;
  }) => Promise<{ inboxId: string; email: string }>;
};

/** Owner-only recovery after a separately authorized inbox deletion. Never deletes mail. */
export async function replaceMissingAgentAddress(
  store: AppStore,
  owner: string,
  agentId: string,
  expectedAddress: string,
  provider: InboxProvider = new AgentMailClient({
    apiKey: process.env.AGENTMAIL_API_KEY!,
  }).inboxes,
) {
  const original = store.agent(owner, agentId);
  if (original.email !== expectedAddress || !original.inbox_id)
    throw new MerchantError(
      "ADDRESS_CHANGED",
      "The agent address changed. Review its current identity before replacing it.",
    );
  try {
    await provider.get(original.inbox_id);
    throw new MerchantError(
      "INBOX_STILL_EXISTS",
      "The original inbox still exists. This action cannot delete it or create an extra inbox.",
    );
  } catch (error) {
    if (!(error instanceof AgentMailError && error.statusCode === 404))
      throw error;
  }
  const oldInbox = original.inbox_id;
  const assertUnused = () => {
    const agent = store.agent(owner, agentId);
    if (agent.inbox_id !== oldInbox || agent.email !== expectedAddress)
      throw new MerchantError(
        "ADDRESS_CHANGED",
        "The agent address changed during replacement.",
      );
    const wallets = store.wallets(owner).filter((w) => w.agent_id === agentId);
    const ids = new Set(wallets.map((w) => w.id));
    if (
      wallets.some((w) => w.vault_id) ||
      store
        .proposals(owner)
        .some(
          (p) =>
            ids.has(p.wallet_id) &&
            ["PAID", "APPROVED", "WAITING", "PAYING", "RECONCILING"].includes(
              p.status,
            ),
        )
    )
      throw new MerchantError(
        "ADDRESS_IN_USE",
        "This identity has a payment permission or committed action. Keep its existing merchant address until those commitments are resolved.",
      );
    return { agent, wallets };
  };
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const { wallets } = assertUnused();
    for (const wallet of wallets) {
      wallet.paused = true;
      wallet.revision++;
      store.saveWallet(wallet);
    }
    const ids = new Set(wallets.map((w) => w.id));
    for (const p of store
      .proposals(owner)
      .filter(
        (p) =>
          ids.has(p.wallet_id) &&
          ["DRAFT", "NEEDS_APPROVAL"].includes(p.status),
      )) {
      p.status = "BLOCKED";
      p.reason =
        "The agent address is being replaced. Prepare a fresh proposal with the new identity.";
      store.saveProposal(p);
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  const suffix = createHash("sha256")
    .update(oldInbox)
    .digest("hex")
    .slice(0, 12);
  const slug =
    original.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "agent";
  const inbox = await provider.create({
    username: `${slug}-${agentId.slice(0, 8)}`,
    displayName: original.name,
    clientId: `replace-${agentId}-${suffix}`,
  });
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const { agent, wallets } = assertUnused();
    agent.inbox_id = inbox.inboxId;
    agent.email = inbox.email;
    agent.status = agent.status === "paused" ? "paused" : "connected";
    store.saveAgent(agent);
    for (const wallet of wallets) {
      wallet.email = inbox.email;
      wallet.inbox_id = inbox.inboxId;
      store.saveWallet(wallet);
    }
    store.log(
      owner,
      "ADDRESS_REPLACED",
      `Replaced missing inbox ${expectedAddress} with ${inbox.email}. Stored messages and history retained; existing wallets remain paused.`,
    );
    store.db.exec("COMMIT");
    return store.publicAgent(agent);
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
