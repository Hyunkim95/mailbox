import { NextRequest } from "next/server";
import { isMerchantError } from "@mailbox/service-sdk";
import {
  merchantRuntime,
  captureVerifier,
  webhookVerifier,
} from "../../../src/merchant-runtime";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const text = await request.text();
    if (text.length > 65536)
      return Response.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    const event = JSON.parse(text);
    const headers = Object.fromEntries(request.headers.entries());
    if (!(await webhookVerifier()(headers, event)))
      return Response.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED")
      return Response.json({ ignored: true });
    if (typeof event.resource?.id !== "string")
      return Response.json({ error: "INVALID_EVENT" }, { status: 400 });
    const capture = await captureVerifier()(event.resource.id);
    const action = await merchantRuntime().confirmCapture(
      capture.invoice_id,
      capture.id,
      async () => capture,
    );
    return Response.json({ action_id: action.id, status: action.status });
  } catch (error) {
    if (isMerchantError(error) && error.code === "ACTION_NOT_FOUND")
      return Response.json({ ignored: true });
    return Response.json(
      { error: isMerchantError(error) ? error.code : "INVALID_EVENT" },
      { status: 503 },
    );
  }
}
