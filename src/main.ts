import {
  MerchantError,
  Merchant,
  createMerchantHttp,
  paypalSandboxVerifier,
  paypalSandboxWebhookVerifier,
} from "@mailbox/service-sdk";
import { catalogue } from "./catalogue.ts";

const token = process.env.MOCK_MERCHANT_TOKEN;
const adminToken = process.env.MOCK_ADMIN_TOKEN;
if (
  !token ||
  !adminToken ||
  token.length < 32 ||
  adminToken.length < 32 ||
  token === adminToken
)
  throw new Error(
    "Set distinct MOCK_MERCHANT_TOKEN and MOCK_ADMIN_TOKEN secrets of at least 32 characters.",
  );
const merchant = new Merchant(
  process.env.MOCK_DATABASE_PATH ?? "./data/merchant.sqlite",
  catalogue.services,
  process.env.MOCK_CUSTOMER_ID ?? "maya",
);
const configured = [
  process.env.PAYPAL_CLIENT_ID,
  process.env.PAYPAL_CLIENT_SECRET,
  process.env.PAYPAL_MERCHANT_ID,
].every((value) => value && !value.startsWith("your_"));
const verifyCapture = configured
  ? paypalSandboxVerifier({
      clientId: process.env.PAYPAL_CLIENT_ID!,
      secret: process.env.PAYPAL_CLIENT_SECRET!,
      merchantId: process.env.PAYPAL_MERCHANT_ID!,
    })
  : async () => {
      throw new MerchantError(
        "PAYMENT_NOT_CONFIGURED",
        "PayPal sandbox credentials are not configured. No payment can be accepted.",
      );
    };
const publicHost = process.env.MOCK_PUBLIC_HOST;
const verifyWebhook =
  configured && process.env.PAYPAL_WEBHOOK_ID
    ? paypalSandboxWebhookVerifier({
        clientId: process.env.PAYPAL_CLIENT_ID!,
        secret: process.env.PAYPAL_CLIENT_SECRET!,
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
      })
    : undefined;
const http = createMerchantHttp({
  merchant,
  token,
  adminToken,
  verifyCapture,
  ...(verifyWebhook ? { verifyWebhook } : {}),
  ...(publicHost ? { publicHost } : {}),
});
const port = Number(process.env.MOCK_MERCHANT_PORT ?? 3011);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid MOCK_MERCHANT_PORT.");
const interval = setInterval(() => merchant.settleDue(), 10_000);
interval.unref();
http.listen(port, publicHost ? "0.0.0.0" : "127.0.0.1", () =>
  console.error(
    `Mailbox fixture MCP listening on port ${port}; sandbox payment verification ${configured ? "configured" : "not configured"}.`,
  ),
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  http.close(() => merchant.close());
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
