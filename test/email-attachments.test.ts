import { test } from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/app-store.ts";
import { syncAgentInbox } from "../src/email.ts";

test("attachment failures retry on the same source, readable flags recover and unsupported files do not loop", async () => {
  const keys = ["AGENTMAIL_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    before = keys.map((k) => process.env[k]);
  process.env.AGENTMAIL_API_KEY = "attachment-test-key";
  process.env.OPENAI_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  const original = globalThis.fetch,
    store = new AppStore(":memory:"),
    actor = store.createAgent("owner", {
      name: "Records",
      purpose: "Collect supporting evidence",
    });
  actor.email = "records@example.test";
  actor.inbox_id = actor.email;
  actor.status = "connected";
  store.saveAgent(actor);
  const text = Buffer.from(
    "Invoice attachment. Reference FILE-204. Total USD 24.00.",
  );
  let attempts = 0,
    unsupported = false,
    gets = 0,
    imageDownloads = 0;
  const message = (id: string, type: string, size: number) => ({
    inbox_id: actor.inbox_id,
    thread_id: id,
    message_id: id,
    labels: ["inbox"],
    timestamp: "2026-11-11T12:00:00Z",
    from: "Files <files@example.test>",
    reply_to: ["records@example.test"],
    to: [actor.email],
    subject: `File ${id}`,
    text: "Please keep the attached supporting file.",
    attachments: [
      {
        attachment_id: id,
        filename: `${id}.${type === "text/plain" ? "txt" : "png"}`,
        content_type: type,
        size,
      },
    ],
    size: 64,
    created_at: "2026-11-11T12:00:00Z",
    updated_at: "2026-11-11T12:00:00Z",
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "attachments.example.test") {
      if (url.pathname === "/text") {
        attempts++;
        return attempts === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : new Response(text);
      }
      imageDownloads++;
      return new Response(new Uint8Array([1, 2, 3]));
    }
    assert.equal(url.hostname, "api.agentmail.to");
    if (url.pathname.endsWith("/attachments/text"))
      return Response.json({
        download_url: "https://attachments.example.test/text",
        attachment_id: "text",
        size: text.length,
        expires_at: "2027-01-01T00:00:00Z",
      });
    if (url.pathname.endsWith("/attachments/image"))
      return Response.json({
        download_url: "https://attachments.example.test/image",
        attachment_id: "image",
        size: 3,
        expires_at: "2027-01-01T00:00:00Z",
      });
    if (url.pathname.endsWith("/messages/text")) {
      gets++;
      return Response.json(message("text", "text/plain", text.length));
    }
    if (url.pathname.endsWith("/messages/image"))
      return Response.json(message("image", "image/png", 3));
    assert(url.pathname.endsWith("/messages"));
    const messages = [
      message("text", "text/plain", text.length),
      ...(unsupported ? [message("image", "image/png", 3)] : []),
    ];
    return Response.json({ count: messages.length, messages });
  };
  try {
    await syncAgentInbox(store, actor);
    const first = store.messages("owner")[0]!;
    assert.equal(first.media!.unread_attachments, true);
    assert.equal(first.attachments![0]!.read_status, "retry");
    assert.equal(store.documents("owner").length, 0);
    await syncAgentInbox(store, actor);
    const recovered = store.messages("owner")[0]!;
    assert.equal(recovered.id, first.id);
    assert.equal(
      recovered.media!.unread_attachments,
      false,
      JSON.stringify({
        attempts,
        gets,
        attachment: recovered.attachments,
        documents: store
          .documents("owner")
          .map((d) => ({ status: d.status, limitation: d.limitation })),
      }),
    );
    assert.equal(recovered.attachments![0]!.read_status, "readable");
    assert(recovered.attachments![0]!.document_id);
    assert.equal(store.documents("owner").length, 1);
    store.updateAttachmentReadState("owner", recovered.id, [
      {
        id: "text",
        filename: "text.txt",
        content_type: "text/plain",
        size: text.length,
        read_status: "retry",
      },
    ]);
    assert.equal(store.messages("owner")[0]!.media!.unread_attachments, false);
    store.saveMessage({
      ...recovered,
      text: "Replacement preview",
      origin: "fixture_preview",
    });
    assert.equal(store.messages("owner")[0]!.text, recovered.text);
    await syncAgentInbox(store, actor);
    assert.equal(attempts, 2);
    assert.equal(gets, 2);
    unsupported = true;
    await syncAgentInbox(store, actor);
    await syncAgentInbox(store, actor);
    const image = store
      .messages("owner")
      .find((m) => m.subject === "File image")!;
    assert.equal(image.media!.unread_attachments, true);
    assert.equal(image.attachments![0]!.read_status, "unread");
    assert.equal(imageDownloads, 1);
    assert.equal(store.documents("owner").length, 2);
    assert.throws(
      () =>
        store.updateAttachmentReadState("owner", image.id, [
          {
            ...image.attachments![0]!,
            document_id: recovered.attachments![0]!.document_id!,
            read_status: "readable",
          },
        ]),
      /different source/,
    );
    assert.throws(
      () => store.document("stranger", recovered.attachments![0]!.document_id!),
      /not available/,
    );
  } finally {
    globalThis.fetch = original;
    store.close();
    keys.forEach((k, i) => {
      if (before[i] === undefined) delete process.env[k];
      else process.env[k] = before[i];
    });
  }
});
