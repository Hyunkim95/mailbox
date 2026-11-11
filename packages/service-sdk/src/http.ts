import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { MerchantError, isMerchantError } from "./definition.js";
import { createMerchantMcp } from "./mcp.js";
import { Merchant } from "./merchant.js";
import type { CaptureVerifier, WebhookVerifier } from "./payments.js";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function authorized(req: IncomingMessage, token: string | undefined) {
  if (!token) return false;
  const received = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 65_536)
      throw new MerchantError(
        "REQUEST_TOO_LARGE",
        "Maximum request size is 64 KiB.",
      );
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MerchantError("INVALID_JSON", "Send a JSON request.");
  }
}

export function createMerchantHttp(options: {
  merchant: Merchant;
  token: string;
  adminToken: string;
  verifyCapture: CaptureVerifier;
  verifyWebhook?: WebhookVerifier;
  publicHost?: string;
}) {
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  return createServer(async (req, res) => {
    try {
      if (options.publicHost) {
        const host = req.headers.host?.split(":")[0];
        if (
          host !== options.publicHost &&
          host !== "localhost" &&
          host !== "127.0.0.1"
        ) {
          json(res, 403, { error: "HOST_NOT_ALLOWED" });
          return;
        }
        if (req.headers.origin) {
          let origin: URL;
          try {
            origin = new URL(req.headers.origin);
          } catch {
            json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
            return;
          }
          if (origin.hostname !== options.publicHost) {
            json(res, 403, { error: "ORIGIN_NOT_ALLOWED" });
            return;
          }
        }
      } else if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health" && req.method === "GET") {
        json(res, 200, { status: "ok", fixture: true });
        return;
      }
      if (url.pathname === "/webhooks/paypal" && req.method === "POST") {
        if (!options.verifyWebhook) {
          json(res, 503, { error: "WEBHOOK_NOT_CONFIGURED" });
          return;
        }
        const event = (await body(req)) as {
          event_type?: unknown;
          resource?: { id?: unknown };
        };
        if (!(await options.verifyWebhook(req.headers, event))) {
          json(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" });
          return;
        }
        if (event?.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
          json(res, 200, { ignored: true });
          return;
        }
        if (typeof event.resource?.id !== "string")
          throw new MerchantError(
            "INVALID_EVENT",
            "Capture event ID is required.",
          );
        const verified = await options.verifyCapture(event.resource.id);
        try {
          const action = await options.merchant.confirmCapture(
            verified.invoice_id,
            verified.id,
            async () => verified,
          );
          json(res, 200, { action_id: action.id, status: action.status });
        } catch (error) {
          if (isMerchantError(error) && error.code === "ACTION_NOT_FOUND")
            json(res, 200, { ignored: true });
          else throw error;
        }
        return;
      }
      if (url.pathname.startsWith("/internal/")) {
        if (!authorized(req, options.adminToken)) {
          json(res, 401, { error: "UNAUTHORIZED" });
          return;
        }
        if (url.pathname === "/internal/outbox" && req.method === "GET") {
          options.merchant.settleDue();
          json(res, 200, { emails: options.merchant.outbox() });
          return;
        }
        const data = req.method === "POST" ? await body(req) : undefined;
        if (url.pathname === "/internal/payments" && req.method === "POST") {
          const input = data as {
            action_id?: unknown;
            capture_id?: unknown;
            order_id?: unknown;
          };
          if (
            !input ||
            typeof input.action_id !== "string" ||
            typeof input.capture_id !== "string"
          )
            throw new MerchantError(
              "INVALID_INPUT",
              "action_id and capture_id required.",
            );
          const action = await options.merchant.confirmCapture(
            input.action_id,
            input.capture_id,
            options.verifyCapture,
            typeof input.order_id === "string" ? input.order_id : undefined,
          );
          json(res, 200, { action });
          return;
        }
        if (url.pathname === "/internal/outbox/ack" && req.method === "POST") {
          const input = data as { id?: unknown; provider_message_id?: unknown };
          if (
            !input ||
            typeof input.id !== "string" ||
            typeof input.provider_message_id !== "string" ||
            !input.provider_message_id.trim()
          )
            throw new MerchantError(
              "INVALID_INPUT",
              "Email and actual provider message IDs required.",
            );
          options.merchant.acknowledgeEmail(
            input.id,
            input.provider_message_id,
          );
          json(res, 200, { acknowledged: true });
          return;
        }
        json(res, 404, { error: "NOT_FOUND" });
        return;
      }
      const match = /^\/mcp(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
      if (!match) {
        json(res, 404, { error: "NOT_FOUND" });
        return;
      }
      if (!authorized(req, options.token)) {
        json(res, 401, { error: "UNAUTHORIZED" });
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        json(res, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const serviceId = match[1];
      if (serviceId) options.merchant.serviceById(serviceId);
      const parsed = await body(req);
      options.merchant.settleDue();
      const server = createMerchantMcp(options.merchant, serviceId);
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } finally {
        await server.close();
      }
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (isMerchantError(error))
        json(res, error.code === "REQUEST_TOO_LARGE" ? 413 : 400, {
          error: error.code,
          message: error.message,
        });
      else {
        console.error(
          "Mock merchant request failed:",
          error instanceof Error ? error.name : "unknown error",
        );
        json(res, 500, { error: "INTERNAL_ERROR" });
      }
    }
  });
}
