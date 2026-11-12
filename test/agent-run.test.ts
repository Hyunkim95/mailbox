import { test } from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/app-store.ts";
import { runAgent } from "../src/agent-run.ts";
import type { AgentTurn } from "../src/agent-model.ts";
import type { Message } from "../src/app-model.ts";
import { catalogue } from "../src/catalogue.ts";

function fixture() {
  const store = new AppStore(
    ":memory:",
    () => new Date("2026-11-11T12:00:00Z"),
  );
  const agent = store.createAgent("owner", {
    name: "Coordinator",
    purpose: "Help me handle correspondence and deadlines",
  });
  const other = store.createAgent("owner", {
    name: "Private",
    purpose: "Separate correspondence",
  });
  const foreign = store.createAgent("someone-else", {
    name: "Other owner",
    purpose: "Private",
  });
  function message(
    id: string,
    subject: string,
    text: string,
    scope = agent,
    attachments = false,
  ) {
    const m: Message = {
      id,
      owner: scope.owner,
      agent_id: scope.id,
      service_id: "external:organiser",
      provider_id: null,
      subject,
      from: "Organiser <hello@example.test>",
      text,
      received_at: store.now().toISOString(),
      kind: "other",
      facts: {
        item: null,
        amount_minor: null,
        expires: null,
        action_id: null,
        suspicious: false,
      },
      origin: "fixture_preview",
      media: {
        image_count: 0,
        needs_vision: false,
        unread_attachments: attachments,
      },
    };
    store.saveMessage(m);
    return m;
  }
  async function run(
    turn: AgentTurn,
    text = "Help with these messages",
    maxSteps = 16,
  ) {
    return runAgent({
      owner: "owner",
      agentId: agent.id,
      text,
      store,
      turn,
      maxSteps,
      services: async () => catalogue.services,
      propose: async () => {
        throw Error("Unexpected proposal");
      },
    });
  }
  return { store, agent, other, foreign, message, run };
}

test("an unfamiliar correspondence task composes search, multiple reads, persistent task tracking and a reviewable reply", async () => {
  const f = fixture();
  try {
    f.message(
      "request",
      "Exhibition preparations",
      "Please send the venue date, insurance and equipment list.",
    );
    f.message(
      "venue",
      "Venue confirmation",
      "The exhibition is on 18 November. Insurance is attached.",
      f.agent,
      true,
    );
    const calls = [
      { name: "search_messages", arguments: { query: "" } },
      { name: "read_message", arguments: { message_id: "request" } },
      { name: "read_message", arguments: { message_id: "venue" } },
      {
        name: "record_task",
        arguments: {
          task_id: null,
          text: "Confirm insurance and equipment",
          status: "blocked",
          sources: ["request", "venue"],
          note: "Insurance attachment is unread; no equipment list found.",
        },
      },
      {
        name: "prepare_reply",
        arguments: {
          message_id: "request",
          document_ids: [],
          body: "The venue is confirmed for 18 November. I still need to verify insurance and provide the equipment list.",
          sources: ["request", "venue"],
        },
      },
      {
        name: "finish",
        arguments: {
          answer: "Reply prepared. Insurance and equipment remain outstanding.",
          sources: ["request", "venue"],
        },
      },
    ];
    const result = await f.run(async (context, history) => {
      assert.equal(
        (context as { agent: { name: string } }).agent.name,
        "Coordinator",
      );
      if (history.length === 1)
        assert.equal((history[0]!.result as { total: number }).total, 2);
      if (history.length === 3)
        assert.equal(
          (history[2]!.result as Message).media!.unread_attachments,
          true,
        );
      const call = calls[history.length]!;
      return { id: String(history.length), ...call };
    });
    assert.equal(result.type, "reply");
    assert("draft" in result);
    assert.match(result.draft.body, /still need/);
    assert.equal(f.store.proposals("owner").length, 0);
    const reread = await f.run(async (_context, history) => {
      if (!history.length)
        return { id: "tasks", name: "read_tasks", arguments: {} };
      const tasks = (
        history[0]!.result as { tasks: { text: string; status: string }[] }
      ).tasks;
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]!.status, "blocked");
      return {
        id: "done",
        name: "finish",
        arguments: { answer: tasks[0]!.text, sources: [] },
      };
    }, "What did we leave outstanding?");
    assert.match(reread.answer, /insurance/);
  } finally {
    f.store.close();
  }
});

test("cross-agent evidence, fabricated citations, unknown action tools and unobserved quotes are rejected", async () => {
  const f = fixture();
  try {
    f.message("own", "One", "Visible");
    f.message("private", "Two", "Hidden", f.other);
    f.message("foreign", "Three", "Hidden", f.foreign);
    const calls = [
      { name: "search_messages", arguments: { query: "" } },
      { name: "read_message", arguments: { message_id: "private" } },
      { name: "read_message", arguments: { message_id: "foreign" } },
      {
        name: "finish",
        arguments: { answer: "Unfounded claim", sources: ["own"] },
      },
      { name: "approve", arguments: { id: "anything" } },
      {
        name: "prepare_proposal",
        arguments: {
          quote_id: "invented",
          rationale: "Invented",
          sources: [],
          condition_under_minor: null,
        },
      },
      {
        name: "finish",
        arguments: {
          answer: "The requested action is unavailable.",
          sources: [],
        },
      },
    ];
    await f.run(async (_context, history) => {
      if (history.length === 1)
        assert.deepEqual(
          (history[0]!.result as { messages: Message[] }).messages.map(
            (m) => m.id,
          ),
          ["own"],
        );
      if (history.length > 1)
        assert("error" in (history.at(-1)!.result as object));
      return { id: String(history.length), ...calls[history.length]! };
    });
    assert.equal(f.store.proposals("owner").length, 0);
    assert.equal(f.store.proposals("someone-else").length, 0);
  } finally {
    f.store.close();
  }
});

test("a repeated tool call stops at the run limit without authorizing anything", async () => {
  const f = fixture();
  try {
    let turns = 0;
    const result = await f.run(
      async () => ({
        id: String(turns++),
        name: "search_messages",
        arguments: { query: "missing" },
      }),
      "Search for something",
      3,
    );
    assert.equal(turns, 3);
    assert.match(result.answer, /step limit/);
    assert.equal(f.store.wallets("owner").length, 0);
  } finally {
    f.store.close();
  }
});

test("a mismatched current quote cannot be used to prepare a proposal", async () => {
  const f = fixture();
  try {
    const s = catalogue.services[0]!;
    const result = await runAgent({
      owner: "owner",
      agentId: f.agent.id,
      text: "Get a quote",
      store: f.store,
      services: async () => [s],
      propose: async () => {
        throw Error("Must not prepare");
      },
      quote: async () => ({
        id: "bad",
        service_id: "other",
        item_id: s.items[0]!.id,
        item_name: "Wrong service",
        quantity: 1,
        amount_minor: 100,
        currency: "USD",
        terms: "None",
        created_at: f.store.now().toISOString(),
        expires_at: "2026-11-12T12:00:00Z",
        kind: s.kind,
      }),
      turn: async (_context, history) => {
        if (!history.length)
          return {
            id: "list",
            name: "list_services",
            arguments: { query: "" },
          };
        if (history.length === 1)
          return {
            id: "quote",
            name: "get_quote",
            arguments: {
              service_id: s.id,
              item_id: s.items[0]!.id,
              quantity: 1,
              booking: null,
            },
          };
        assert.equal(
          (history[1]!.result as { error: string }).error,
          "QUOTE_INVALID",
        );
        return {
          id: "finish",
          name: "finish",
          arguments: { answer: "No valid quote was returned.", sources: [] },
        };
      },
    });
    assert.match(result.answer, /No valid quote/);
    assert.equal(f.store.proposals("owner").length, 0);
  } finally {
    f.store.close();
  }
});

test("an agent run cannot silently acquire workspace-wide inbox access", async () => {
  const f = fixture();
  try {
    let called = false;
    await assert.rejects(
      runAgent({
        owner: "owner",
        text: "Read everything",
        store: f.store,
        services: async () => [],
        propose: async () => {
          throw Error("Must not prepare");
        },
        turn: async () => {
          called = true;
          return {
            id: "x",
            name: "finish",
            arguments: { answer: "No", sources: [] },
          };
        },
      }),
      /Choose an agent/,
    );
    assert.equal(called, false);
  } finally {
    f.store.close();
  }
});
