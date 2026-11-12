import { test } from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/app-store.ts";
import { AppService } from "../src/app-service.ts";
import { replyAddresses } from "../src/reply-routing.ts";
import type { Message } from "../src/app-model.ts";

test("reply routing uses verified Reply-To addresses and rejects ambiguous headers", () => {
  assert.deepEqual(
    replyAddresses({
      from: "Finance <sender@example.test>",
      reply_to: ["Accounts <records@example.test>"],
    }),
    ["records@example.test"],
  );
  assert.deepEqual(
    replyAddresses({ from: "Finance <sender@example.test>", reply_to: [] }),
    ["sender@example.test"],
  );
  assert.deepEqual(
    replyAddresses({ from: "a@example.test,b@example.test" }),
    [],
  );
  assert.deepEqual(
    replyAddresses({ from: "a@example.test", reply_to: ["bad recipient"] }),
    [],
  );
});
test("uncertain sends keep the approved payload bound to the original idempotency key", async () => {
  const store = new AppStore(":memory:");
  try {
    const agent = store.createAgent("owner", {
      name: "Records",
      purpose: "Correspondence",
    });
    agent.email = "records@example.test";
    agent.inbox_id = agent.email;
    store.saveAgent(agent);
    const message: Message = {
      id: "request",
      owner: "owner",
      agent_id: agent.id,
      service_id: "email:finance",
      provider_id: agent.inbox_id + ":original",
      from: "Finance <finance@example.test>",
      reply_to: ["accounts@example.test"],
      subject: "Receipt request",
      text: "Please send the original invoice.",
      received_at: store.now().toISOString(),
      kind: "other",
      origin: "agentmail",
      facts: {
        item: null,
        amount_minor: null,
        expires: null,
        action_id: null,
        suspicious: false,
      },
    };
    store.saveMessage(message);
    let attempts = 0;
    const delivered = new Set<string>();
    const app = new AppService(store, undefined, {
      provisionAddress: async (_s, w) => w,
      deliverOutbox: async () => {},
      syncInbox: async () => {},
      sendReply: async (_a, _m, _body, key) => {
        attempts++;
        delivered.add(key);
        if (attempts === 1) throw Error("Acknowledgement lost after delivery");
        return "provider-original";
      },
    });
    await assert.rejects(
      app.sendReply("owner", message.id, "The reviewed body", "approval-1"),
      /Acknowledgement lost/,
    );
    await assert.rejects(
      app.sendReply("owner", message.id, "Changed body", "approval-1"),
      /different content/,
    );
    assert.equal(attempts, 1);
    const sent = await app.sendReply(
      "owner",
      message.id,
      "The reviewed body",
      "approval-1",
    );
    assert.deepEqual(sent.to_addresses, ["accounts@example.test"]);
    assert.equal(sent.provider_message_id, "provider-original");
    assert.equal(delivered.size, 1);
    await app.sendReply("owner", message.id, "The reviewed body", "approval-1");
    assert.equal(attempts, 2);
    store.saveMessage({
      ...message,
      id: "another",
      provider_id: agent.inbox_id + ":another",
    });
    await assert.rejects(
      app.sendReply("owner", "another", "The reviewed body", "approval-1"),
      /different content/,
    );
  } finally {
    store.close();
  }
});
test("routing backfill cannot change received content, cross owners or overwrite checked routing", () => {
  const store = new AppStore(":memory:");
  try {
    const message: Message = {
      id: "original",
      owner: "owner",
      service_id: "email:finance",
      provider_id: "inbox:message",
      from: "finance@example.test",
      subject: "Original",
      text: "Original body",
      received_at: store.now().toISOString(),
      kind: "other",
      origin: "agentmail",
      facts: {
        item: null,
        amount_minor: null,
        expires: null,
        action_id: null,
        suspicious: false,
      },
    };
    store.saveMessage(message);
    assert.throws(
      () => store.recordReplyRouting("other", "original", "inbox:message", []),
      /same received/,
    );
    assert.throws(
      () =>
        store.recordReplyRouting("owner", "original", "different:message", []),
      /same received/,
    );
    const m = store.recordReplyRouting("owner", "original", "inbox:message", [
      "accounts@example.test",
    ]);
    assert.equal(m.text, "Original body");
    assert.equal(m.subject, "Original");
    assert.deepEqual(
      store.recordReplyRouting("owner", "original", "inbox:message", [
        "changed@example.test",
      ]).reply_to,
      ["accounts@example.test"],
    );
  } finally {
    store.close();
  }
});
