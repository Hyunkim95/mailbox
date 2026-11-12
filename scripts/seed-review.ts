import { readFileSync } from "node:fs";
import { AppStore } from "../src/app-store.ts";
import { importDocument } from "../src/documents.ts";
import type { Message } from "../src/app-model.ts";
import { sampleAgents } from "../src/agents.ts";
const owner = process.env.DEMO_WORKSPACE_ID;
if (!owner || !process.env.APP_DATABASE_PATH?.includes("artifacts/demo/"))
  throw Error(
    "Use a dedicated artifacts/demo database and review workspace ID.",
  );
const data = JSON.parse(
  readFileSync("fixtures/review-workflows.json", "utf8"),
) as {
  agents: { name: string; purpose: string }[];
  messages: {
    id: string;
    agent: string;
    from: string;
    subject: string;
    text: string;
    received_at: string;
  }[];
  documents: {
    agent: string;
    message: string;
    filename: string;
    content_type: string;
    text: string;
  }[];
};
const store = new AppStore(process.env.APP_DATABASE_PATH);
try {
  sampleAgents(store, owner);
  const agents = new Map(
    data.agents.map((input) => [
      input.name,
      store.agents(owner).find((a) => a.name === input.name) ??
        store.createAgent(owner, input),
    ]),
  );
  for (const input of data.messages) {
    const m: Message = {
      id: `review:${owner}:${input.id}`,
      owner,
      agent_id: agents.get(input.agent)!.id,
      service_id: `email:${input.from}`,
      provider_id: null,
      subject: input.subject,
      from: input.from,
      text: input.text,
      received_at: input.received_at,
      kind: "other",
      facts: {
        item: null,
        amount_minor: null,
        expires: null,
        action_id: null,
        suspicious: false,
      },
      origin: "fixture_preview",
    };
    store.saveMessage(m);
  }
  for (const doc of data.documents)
    await importDocument(store, owner, agents.get(doc.agent)!.id, {
      filename: doc.filename,
      content_type: doc.content_type,
      bytes: new TextEncoder().encode(doc.text),
      message_id: `review:${owner}:${doc.message}`,
      origin: "fixture_preview",
    });
  console.log(
    JSON.stringify({
      workspace: owner,
      agents: [...agents].map(([name, a]) => ({ name, id: a.id })),
      messages: store.messages(owner).length,
      documents: store.documents(owner).length,
    }),
  );
} finally {
  store.close();
}
