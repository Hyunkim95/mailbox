import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const token = process.env.MOCK_MERCHANT_TOKEN;
if (!token)
  throw new Error(
    "Load .env and start the merchant before running this client.",
  );
const origin =
  process.env.MOCK_MERCHANT_URL ??
  `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
async function connect(path: string) {
  const client = new Client({ name: "mailbox-demo", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(path, origin), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
const catalogue = await connect("/mcp");
const streaming = await connect("/mcp/coast-screen");
try {
  const matches = await catalogue.callTool({
    name: "search_catalogue",
    arguments: { query: "The Lantern Coast" },
  });
  console.log(
    "Fictional viewing options:",
    JSON.stringify(matches.structuredContent, null, 2),
  );
  const response = await streaming.callTool({
    name: "get_quote",
    arguments: { item_id: "monthly" },
  });
  const quote = (response.structuredContent as { data: { id: string } }).data;
  const action = await streaming.callTool({
    name: "subscribe",
    arguments: {
      quote_id: quote.id,
      address: "coast-screen@example.test",
      idempotency_key: `demo-${randomUUID()}`,
      paid_periods: 1,
    },
  });
  console.log(
    "Prepared via real MCP, not a payment:",
    JSON.stringify(action.structuredContent, null, 2),
  );
} finally {
  await catalogue.close();
  await streaming.close();
}
