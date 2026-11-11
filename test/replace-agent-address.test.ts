import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentMailError } from "agentmail";
import { AppStore } from "../src/app-store.ts";
import { catalogue } from "../src/catalogue.ts";
import { replaceMissingAgentAddress } from "../src/replace-agent-address.ts";
import { fixtureMessages } from "../src/seed.ts";

test("replacement requires an absent inbox and preserves scoped history without granting financial authority", async () => {
  const store = new AppStore(":memory:");
  try {
    const agent = store.createAgent("owner", {
      name: "Dev",
      purpose: "Project accounts",
    });
    agent.email = "old@example.test";
    agent.inbox_id = agent.email;
    store.saveAgent(agent);
    const w = store.ensureWallet(
      "owner",
      catalogue.services.find((s) => s.id === "basil-market")!,
    );
    store.attachWalletAgent("owner", w.id, agent.id);
    const before = store.wallet("owner", w.id);
    before.email = agent.email;
    before.inbox_id = agent.email;
    store.saveWallet(before);
    const other = store.createAgent("owner", {
      name: "Other",
      purpose: "Unrelated",
    });
    const unrelated = JSON.stringify(other);
    const message = {
      ...fixtureMessages("owner", store.now())[0]!,
      agent_id: agent.id,
    };
    store.saveMessage(message);
    const history = JSON.stringify(store.messages("owner"));
    const created: string[] = [];
    const provider = {
      get: async () => {
        throw new AgentMailError({ statusCode: 404 });
      },
      create: async (input: { clientId: string }) => {
        created.push(input.clientId);
        return { inboxId: "dev@example.test", email: "dev@example.test" };
      },
    };
    await assert.rejects(
      replaceMissingAgentAddress(store, "owner", agent.id, agent.email, {
        ...provider,
        get: async () => ({}),
      }),
      /still exists/,
    );
    await assert.rejects(
      replaceMissingAgentAddress(
        store,
        "stranger",
        agent.id,
        agent.email,
        provider,
      ),
    );
    await assert.rejects(
      replaceMissingAgentAddress(store, "owner", agent.id, agent.email, {
        ...provider,
        get: async () => {
          throw new AgentMailError({ statusCode: 503 });
        },
      }),
    );
    const repaired = await replaceMissingAgentAddress(
      store,
      "owner",
      agent.id,
      agent.email,
      provider,
    );
    assert.equal(repaired.email, "dev@example.test");
    assert.equal(repaired.id, agent.id);
    assert.equal(created.length, 1);
    const after = store.wallet("owner", w.id);
    assert.equal(after.email, repaired.email);
    assert.equal(after.paused, true);
    assert.equal(after.vault_id, null);
    assert.equal(JSON.stringify(store.agent("owner", other.id)), unrelated);
    assert.equal(JSON.stringify(store.messages("owner")), history);
    await assert.rejects(
      replaceMissingAgentAddress(
        store,
        "owner",
        agent.id,
        "old@example.test",
        provider,
      ),
      /address changed/,
    );
    assert.equal(created.length, 1);
  } finally {
    store.close();
  }
});

test("an identity with a saved payment permission cannot be rebound to another address", async () => {
  const store = new AppStore(
    ":memory:",
    () => new Date(),
    "address-repair-test-secret-over-thirty-two-characters",
  );
  try {
    const agent = store.createAgent("owner", {
      name: "Reel",
      purpose: "Media",
    });
    agent.email = "paid@example.test";
    agent.inbox_id = agent.email;
    store.saveAgent(agent);
    const w = store.ensureWallet(
      "owner",
      catalogue.services.find((s) => s.id === "coast-screen")!,
    );
    store.attachWalletAgent("owner", w.id, agent.id);
    const wallet = store.wallet("owner", w.id);
    wallet.vault_id = "saved-token";
    store.saveWallet(wallet);
    await assert.rejects(
      replaceMissingAgentAddress(store, "owner", agent.id, agent.email, {
        get: async () => {
          throw new AgentMailError({ statusCode: 404 });
        },
        create: async () => {
          throw Error("Must not create an inbox");
        },
      }),
      /payment permission/,
    );
    assert.equal(store.agent("owner", agent.id).email, "paid@example.test");
    assert.equal(store.wallet("owner", w.id).paused, false);
  } finally {
    store.close();
  }
});
