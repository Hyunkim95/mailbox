import {
  Merchant,
  MerchantError,
  paypalSandboxVerifier,
  paypalSandboxWebhookVerifier,
} from "@mailbox/service-sdk";
import { catalogue } from "./catalogue.ts";
import { configured } from "./ai.ts";
declare global {
  var mailboxMerchant: Merchant | undefined;
}
export function merchantRuntime() {
  return (globalThis.mailboxMerchant ??= new Merchant(
    process.env.MOCK_DATABASE_PATH ?? "./data/merchant.sqlite",
    catalogue.services,
    process.env.MOCK_CUSTOMER_ID ?? "maya",
  ));
}
export function captureVerifier() {
  if (
    !configured("PAYPAL_CLIENT_ID") ||
    !configured("PAYPAL_CLIENT_SECRET") ||
    !configured("PAYPAL_MERCHANT_ID")
  )
    throw new MerchantError(
      "PAYMENT_NOT_CONFIGURED",
      "PayPal sandbox verification is not configured.",
    );
  return paypalSandboxVerifier({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    secret: process.env.PAYPAL_CLIENT_SECRET!,
    merchantId: process.env.PAYPAL_MERCHANT_ID!,
  });
}
export function webhookVerifier() {
  if (!configured("PAYPAL_CLIENT_ID") || !configured("PAYPAL_WEBHOOK_ID"))
    throw new MerchantError(
      "WEBHOOK_NOT_CONFIGURED",
      "The sandbox webhook is not registered.",
    );
  return paypalSandboxWebhookVerifier({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    secret: process.env.PAYPAL_CLIENT_SECRET!,
    webhookId: process.env.PAYPAL_WEBHOOK_ID!,
  });
}
