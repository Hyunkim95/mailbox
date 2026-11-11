import { MerchantError } from "./definition.js";

export type VerifiedCapture = {
  id: string;
  invoice_id: string;
  amount_minor: number;
  currency: "USD";
  merchant_id: string;
};
export type CaptureVerifier = (
  captureId: string,
  orderId?: string,
) => Promise<VerifiedCapture>;
export type WebhookVerifier = (
  headers: Record<string, string | string[] | undefined>,
  event: unknown,
) => Promise<boolean>;

export function paypalSandboxWebhookVerifier(config: {
  clientId: string;
  secret: string;
  webhookId: string;
  fetch?: typeof fetch;
}): WebhookVerifier {
  const request = config.fetch ?? fetch;
  return async (headers, event) => {
    const required = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    if (required.some((name) => typeof headers[name] !== "string"))
      return false;
    const auth = await request(
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!auth.ok)
      throw new MerchantError(
        "PAYPAL_UNAVAILABLE",
        "Could not verify the sandbox webhook.",
      );
    const token = (await auth.json()) as { access_token: string };
    const verification = await request(
      "https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: headers["paypal-auth-algo"],
          cert_url: headers["paypal-cert-url"],
          transmission_id: headers["paypal-transmission-id"],
          transmission_sig: headers["paypal-transmission-sig"],
          transmission_time: headers["paypal-transmission-time"],
          webhook_id: config.webhookId,
          webhook_event: event,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!verification.ok) return false;
    return (
      ((await verification.json()) as { verification_status?: string })
        .verification_status === "SUCCESS"
    );
  };
}

export function paypalSandboxVerifier(config: {
  clientId: string;
  secret: string;
  merchantId: string;
  fetch?: typeof fetch;
}): CaptureVerifier {
  const request = config.fetch ?? fetch;
  const base = "https://api-m.sandbox.paypal.com";
  return async (captureId, suppliedOrderId) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(captureId))
      throw new MerchantError("INVALID_CAPTURE", "Invalid capture ID.");
    const tokenResponse = await request(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok)
      throw new MerchantError(
        "PAYPAL_UNAVAILABLE",
        "Could not authenticate to PayPal sandbox.",
      );
    const token = (await tokenResponse.json()) as { access_token?: unknown };
    if (typeof token.access_token !== "string")
      throw new MerchantError(
        "PAYPAL_UNAVAILABLE",
        "PayPal token response was incomplete.",
      );
    const response = await request(
      `${base}/v2/payments/captures/${encodeURIComponent(captureId)}`,
      {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new MerchantError(
        "CAPTURE_UNVERIFIED",
        "Could not verify this sandbox capture.",
      );
    const capture = (await response.json()) as {
      id?: string;
      status?: string;
      invoice_id?: string;
      amount?: { value?: string; currency_code?: string };
      payee?: { merchant_id?: string };
      supplementary_data?: { related_ids?: { order_id?: string } };
      links?: { rel: string; href: string }[];
    };
    let invoiceId = capture.invoice_id,
      merchantId = capture.payee?.merchant_id;
    if (!merchantId || !invoiceId) {
      let orderId =
        suppliedOrderId ?? capture.supplementary_data?.related_ids?.order_id;
      if (!orderId) {
        const up = capture.links?.find((link) => link.rel === "up");
        if (up) {
          const parsed = new URL(up.href);
          if (parsed.origin === base && !parsed.search)
            orderId = /^\/v2\/checkout\/orders\/([a-zA-Z0-9_-]{1,128})$/.exec(
              parsed.pathname,
            )?.[1];
        }
      }
      if (!orderId || !/^[a-zA-Z0-9_-]{1,128}$/.test(orderId))
        throw new MerchantError(
          "CAPTURE_MISMATCH",
          "Capture needs its verified owning order.",
        );
      const orderResponse = await request(
        `${base}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!orderResponse.ok)
        throw new MerchantError(
          "CAPTURE_UNVERIFIED",
          "Could not verify the capture owning order.",
        );
      const order = (await orderResponse.json()) as {
        id?: string;
        purchase_units?: {
          invoice_id?: string;
          payee?: { merchant_id?: string };
          payments?: { captures?: { id?: string; status?: string }[] };
        }[];
      };
      if (order.id !== orderId)
        throw new MerchantError(
          "CAPTURE_MISMATCH",
          "Order reference does not match.",
        );
      const unit = order.purchase_units?.find((unit) =>
        unit.payments?.captures?.some(
          (item) => item.id === captureId && item.status === "COMPLETED",
        ),
      );
      if (
        !unit ||
        !unit.invoice_id ||
        (invoiceId && invoiceId !== unit.invoice_id)
      )
        throw new MerchantError(
          "CAPTURE_MISMATCH",
          "Capture is not bound to the expected invoice in its order.",
        );
      invoiceId = unit.invoice_id;
      merchantId = unit.payee?.merchant_id;
    }
    const value = capture.amount?.value;
    if (
      capture.id !== captureId ||
      capture.status !== "COMPLETED" ||
      merchantId !== config.merchantId ||
      capture.amount?.currency_code !== "USD" ||
      typeof value !== "string" ||
      !/^\d+\.\d{2}$/.test(value) ||
      !invoiceId
    ) {
      throw new MerchantError(
        "CAPTURE_MISMATCH",
        "Capture must be completed USD payment to this merchant with the action invoice ID.",
      );
    }
    const [whole, fraction] = value.split(".");
    const amount = Number(whole) * 100 + Number(fraction);
    if (!Number.isSafeInteger(amount))
      throw new MerchantError(
        "CAPTURE_MISMATCH",
        "Capture amount is outside the supported range.",
      );
    return {
      id: captureId,
      invoice_id: invoiceId,
      amount_minor: amount,
      currency: "USD",
      merchant_id: config.merchantId,
    };
  };
}
