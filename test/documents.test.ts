import { test } from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/app-store.ts";
import { importDocument, readBoundedBody } from "../src/documents.ts";
import { AppService } from "../src/app-service.ts";
import type { Message } from "../src/app-model.ts";
import { randomUUID } from "node:crypto";

// Minimal text PDF exercises actual PDF.js extraction, not pre-extracted text.
function pdf(text: string) {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((s, i) => {
    offsets.push(Buffer.byteLength(data));
    data += `${i + 1} 0 obj\n${s}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n ")
    .join(
      "\n",
    )}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(data));
}
test("PDF text is extracted, originals retained, imports deduplicated and ownership enforced", async () => {
  const store = new AppStore(":memory:");
  try {
    const a = store.createAgent("owner", {
        name: "Admin",
        purpose: "Documents",
      }),
      b = store.createAgent("owner", { name: "Travel", purpose: "Travel" });
    const input = {
      filename: "invoice.pdf",
      content_type: "application/pdf",
      bytes: pdf("Invoice AC-108: USD 24.00 paid for October"),
    };
    const d = await importDocument(store, "owner", a.id, input);
    assert.equal(d.status, "readable");
    assert.match(d.text, /USD 24.00/);
    assert.deepEqual(
      store.documentContent("owner", d.id),
      Buffer.from(input.bytes),
    );
    assert.equal((await importDocument(store, "owner", a.id, input)).id, d.id);
    assert.equal(store.documents("owner", a.id).length, 1);
    assert.throws(() => store.document("owner", d.id, b.id), /not available/);
    assert.throws(() => store.document("other", d.id), /not available/);
  } finally {
    store.close();
  }
});
test("unsupported or malformed documents remain unread and size limits stop input", async () => {
  const store = new AppStore(":memory:");
  try {
    const a = store.createAgent("owner", {
      name: "Admin",
      purpose: "Documents",
    });
    const d = await importDocument(store, "owner", a.id, {
      filename: "scan.png",
      content_type: "image/png",
      bytes: new Uint8Array([1, 2]),
    });
    assert.equal(d.status, "unread");
    assert(d.limitation);
    const broken = await importDocument(store, "owner", a.id, {
      filename: "broken.pdf",
      content_type: "application/pdf",
      bytes: new Uint8Array([1, 2]),
    });
    assert.equal(broken.status, "unread");
    await assert.rejects(
      readBoundedBody(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(10));
            c.close();
          },
        }),
        5,
      ),
      /size limit/,
    );
  } finally {
    store.close();
  }
});

test("reply approval validates document scope and draft version, sends the chosen originals once and clears an edited draft", async () => {
  const store = new AppStore(":memory:");
  try {
    const a = store.createAgent("owner", {
        name: "Admin",
        purpose: "Correspondence",
      }),
      b = store.createAgent("owner", {
        name: "Other",
        purpose: "Separate files",
      });
    a.email = "admin@example.test";
    a.inbox_id = "fixture-inbox";
    store.saveAgent(a);
    const message: Message = {
      id: "request",
      owner: "owner",
      agent_id: a.id,
      service_id: "email:sender",
      provider_id: "fixture-inbox:message",
      from: "Sender <sender@example.test>",
      subject: "Documents",
      text: "Please provide the invoice",
      received_at: store.now().toISOString(),
      kind: "other",
      facts: {
        item: null,
        amount_minor: null,
        expires: null,
        action_id: null,
        suspicious: false,
      },
      origin: "agentmail",
      reply_to: [],
    };
    store.saveMessage(message);
    const doc = await importDocument(store, "owner", a.id, {
      filename: "invoice.txt",
      content_type: "text/plain",
      bytes: new TextEncoder().encode("Invoice REF-204"),
    });
    const foreign = await importDocument(store, "owner", b.id, {
      filename: "private.txt",
      content_type: "text/plain",
      bytes: new TextEncoder().encode("Private"),
    });
    const id = randomUUID();
    store.setSetting(`agent-reply:owner:${a.id}`, {
      id,
      message_id: message.id,
      body: "Original draft",
      to_address: "sender@example.test",
    });
    const sent: { filename: string; content: string }[][] = [];
    const app = new AppService(store, undefined, {
      provisionAddress: async (_s, w) => w,
      deliverOutbox: async () => {},
      syncInbox: async () => {},
      sendReply: async (_a, _m, _b, _id, files = []) => {
        sent.push(files);
        return "sent";
      },
    });
    await assert.rejects(
      app.sendReply(
        "owner",
        message.id,
        "Edited draft",
        randomUUID(),
        [doc.id],
        randomUUID(),
      ),
      /draft changed/,
    );
    await assert.rejects(
      app.sendReply(
        "owner",
        message.id,
        "Edited draft",
        randomUUID(),
        [foreign.id],
        id,
      ),
      /not available/,
    );
    assert.equal(sent.length, 0);
    const request = randomUUID();
    await app.sendReply(
      "owner",
      message.id,
      "Edited draft",
      request,
      [doc.id],
      id,
    );
    assert.equal(sent.length, 1);
    assert.equal(
      Buffer.from(sent[0]![0]!.content, "base64").toString(),
      "Invoice REF-204",
    );
    assert.equal(store.setting(`agent-reply:owner:${a.id}`), null);
    await app.sendReply(
      "owner",
      message.id,
      "Edited draft",
      randomUUID(),
      [doc.id],
      id,
    );
    assert.equal(sent.length, 1);
    assert.equal(store.proposals("owner").length, 0);
    await assert.rejects(
      app.sendReply(
        "owner",
        message.id,
        "A different reply",
        request,
        [doc.id],
        id,
      ),
      /different content/,
    );
    await assert.rejects(
      app.sendReply("owner", message.id, "Edited draft", request, [], id),
      /different content/,
    );
    assert.equal(sent.length, 1);
  } finally {
    store.close();
  }
});
