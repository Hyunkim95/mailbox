import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { MerchantError, isMerchantError } from "@mailbox/service-sdk";
import { secretReady } from "../../../src/secret-config";
import {
  merchantRuntime,
  captureVerifier,
} from "../../../src/merchant-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function authorized(request: NextRequest) {
  const token = process.env.MOCK_ADMIN_TOKEN;
  if (!secretReady(token) || token === process.env.MOCK_MERCHANT_TOKEN)
    return false;
  const a = Buffer.from(request.headers.get("authorization") ?? ""),
    b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!authorized(request))
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  if ((await context.params).path.join("/") !== "outbox")
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  const merchant = merchantRuntime();
  merchant.settleDue();
  return Response.json(
    { emails: merchant.outbox() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  if (!authorized(request))
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const path = (await context.params).path.join("/"),
      raw = await request.text();
    if (raw.length > 16384)
      return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    const input = JSON.parse(raw),
      merchant = merchantRuntime();
    if (path === "payments") {
      if (
        typeof input.action_id !== "string" ||
        typeof input.capture_id !== "string"
      )
        throw new MerchantError(
          "INVALID_INPUT",
          "Action and capture IDs required.",
        );
      return Response.json({
        action: await merchant.confirmCapture(
          input.action_id,
          input.capture_id,
          captureVerifier(),
          typeof input.order_id === "string" ? input.order_id : undefined,
        ),
      });
    }
    if (path === "outbox/ack") {
      if (
        typeof input.id !== "string" ||
        typeof input.provider_message_id !== "string"
      )
        throw new MerchantError(
          "INVALID_INPUT",
          "Email delivery reference required.",
        );
      merchant.acknowledgeEmail(input.id, input.provider_message_id);
      return Response.json({ acknowledged: true });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  } catch (error) {
    return Response.json(
      {
        error: isMerchantError(error) ? error.code : "INVALID_REQUEST",
        message: isMerchantError(error)
          ? error.message
          : "Invalid internal request.",
      },
      { status: 400 },
    );
  }
}
