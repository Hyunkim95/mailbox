import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  WebStandardStreamableHTTPServerTransport,
  createMerchantMcp,
} from "@mailbox/service-sdk";
import { merchantRuntime } from "../../../src/merchant-runtime";
import { secretReady } from "../../../src/secret-config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ service?: string[] }> },
) {
  const expected = process.env.MOCK_MERCHANT_TOKEN;
  if (!secretReady(expected) || expected === process.env.MOCK_ADMIN_TOKEN)
    return Response.json({ error: "NOT_CONFIGURED" }, { status: 503 });
  const a = Buffer.from(request.headers.get("authorization") ?? ""),
    b = Buffer.from(`Bearer ${expected}`);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== process.env.APP_URL)
    return Response.json({ error: "ORIGIN_NOT_ALLOWED" }, { status: 403 });
  const parts = (await context.params).service ?? [];
  if (parts.length > 1)
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const merchant = merchantRuntime();
  let server;
  try {
    merchant.settleDue();
    server = createMerchantMcp(merchant, parts[0]);
  } catch {
    return Response.json({ error: "SERVICE_NOT_FOUND" }, { status: 404 });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
