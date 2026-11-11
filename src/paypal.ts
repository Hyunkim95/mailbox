import { MerchantError } from "@mailbox/service-sdk";
import { configured } from "./ai.ts";
type PayPalObject = {
  id?: string;
  status?: string;
  links?: { rel: string; href: string }[];
  purchase_units?: {
    payments?: {
      captures?: {
        id: string;
        status: string;
        amount: { value: string; currency_code: string };
      }[];
    };
  }[];
};

export class PayPal {
  constructor(readonly request: typeof fetch = fetch) {}
  async call<T>(
    path: string,
    method = "GET",
    body?: unknown,
    requestId?: string,
  ): Promise<T> {
    if (!configured("PAYPAL_CLIENT_ID") || !configured("PAYPAL_CLIENT_SECRET"))
      throw new MerchantError(
        "PAYPAL_NOT_CONFIGURED",
        "Add PayPal sandbox credentials to connect this wallet.",
      );
    const tokenResponse = await this.request(
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!tokenResponse.ok)
      throw new MerchantError(
        "PAYPAL_AUTH_FAILED",
        "PayPal sandbox credentials were not accepted. Check the sandbox app settings.",
      );
    const token = (await tokenResponse.json()) as { access_token: string };
    const response = await this.request(
      `https://api-m.sandbox.paypal.com${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      let name = "PAYPAL_REQUEST_FAILED";
      try {
        name = ((await response.json()) as { name?: string }).name ?? name;
      } catch {}
      throw new MerchantError(
        name,
        `PayPal sandbox could not complete the request (${response.status}). The original action is retained for reconciliation.`,
      );
    }
    return response.status === 204 ? ({} as T) : ((await response.json()) as T);
  }
  setup(
    walletId: string,
    returnUrl: string,
    cancelUrl: string,
    requestId = walletId,
  ) {
    return this.call<PayPalObject>(
      "/v3/vault/setup-tokens",
      "POST",
      {
        customer: { merchant_customer_id: walletId },
        payment_source: {
          paypal: {
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: true,
            description:
              "Mailbox service wallet with user-controlled spending limits",
            experience_context: {
              brand_name: "Mailbox",
              return_url: returnUrl,
              cancel_url: cancelUrl,
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
      requestId,
    );
  }
  async exchange(setupId: string, requestId: string) {
    const observed = await this.call<PayPalObject>(
      `/v3/vault/setup-tokens/${encodeURIComponent(setupId)}`,
    );
    if (observed.status !== "APPROVED")
      throw new MerchantError(
        "PAYPAL_NOT_APPROVED",
        "PayPal has not confirmed wallet approval.",
      );
    const result = await this.call<PayPalObject>(
      "/v3/vault/payment-tokens",
      "POST",
      { payment_source: { token: { id: setupId, type: "SETUP_TOKEN" } } },
      requestId,
    );
    if (!result.id)
      throw new MerchantError(
        "PAYPAL_TOKEN_MISSING",
        "PayPal did not return a saved payment token.",
      );
    return result.id;
  }
  createOrder(
    actionId: string,
    amount: number,
    vaultId: string,
    requestId: string,
  ) {
    return this.call<PayPalObject>(
      "/v2/checkout/orders",
      "POST",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            invoice_id: actionId,
            custom_id: actionId,
            payee: { merchant_id: process.env.PAYPAL_MERCHANT_ID },
            amount: { currency_code: "USD", value: (amount / 100).toFixed(2) },
          },
        ],
        payment_source: {
          paypal: {
            vault_id: vaultId,
            stored_credential: {
              payment_initiator: "MERCHANT",
              usage: "SUBSEQUENT",
              usage_pattern: "UNSCHEDULED_PREPAID",
            },
          },
        },
      },
      requestId,
    );
  }
  getOrder(id: string) {
    return this.call<PayPalObject>(
      `/v2/checkout/orders/${encodeURIComponent(id)}`,
    );
  }
  captureOrder(id: string, requestId: string) {
    return this.call<PayPalObject>(
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      "POST",
      {},
      requestId,
    );
  }
  removeToken(id: string) {
    return this.call(
      `/v3/vault/payment-tokens/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
}
