# Mailbox service SDK

A thin, experimental merchant layer over standard MCP and PayPal sandbox APIs. The reference app uses this package for every invented service. No outside merchant adoption or universal consumer-service coverage is claimed.

## Describe a service

```ts
import { createService } from '@mailbox/service-sdk';

const service = createService({
  id: 'coast-screen',
  name: 'Coast Screen',
  category: 'entertainment',
  paypalMerchant: process.env.PAYPAL_MERCHANT_ID!,
  plans: [{
    id: 'monthly',
    name: 'One month of Coast Screen',
    amount_minor: 799,
    period: 'month',
    includes: ['The Lantern Coast'],
    terms: 'One paid month. Renewal disabled.'
  }]
});
```

Use `plans` for the supported one-month subscription template, `catalogue` for one-off products, or `catalogue` plus `booking` for deposit bookings. Prices are integer USD cents. Product metadata can include stock, pack quantity/unit and a comparison group. A new service within these supported capabilities is new configuration; a new capability still requires implementation.

## Mount the shared host

`Merchant` owns durable fixture lifecycle state. `createMerchantMcp(merchant, serviceId)` registers service-scoped MCP tools; the reference app mounts them with the official SDK's Streamable HTTP transport. `createMerchantHttp` provides a standalone Node HTTP host with protected integration routes. One merchant host uses one PayPal business account.

```ts
import {
  Merchant, createMerchantHttp,
  paypalSandboxVerifier, paypalSandboxWebhookVerifier
} from '@mailbox/service-sdk';

const merchant = new Merchant('./merchant.sqlite', [service]);
const server = createMerchantHttp({
  merchant,
  token: process.env.MOCK_MERCHANT_TOKEN!,
  adminToken: process.env.MOCK_ADMIN_TOKEN!,
  verifyCapture: paypalSandboxVerifier({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    secret: process.env.PAYPAL_CLIENT_SECRET!,
    merchantId: process.env.PAYPAL_MERCHANT_ID!
  }),
  verifyWebhook: paypalSandboxWebhookVerifier({
    clientId: process.env.PAYPAL_CLIENT_ID!,
    secret: process.env.PAYPAL_CLIENT_SECRET!,
    webhookId: process.env.PAYPAL_WEBHOOK_ID!
  })
});
server.listen(3011, '127.0.0.1');
```

The host exposes catalogue/plan/quote/status tools, plus `subscribe`/`cancel`, `place_order` or `book` as appropriate. Streaming subscriptions permit one paid period and keep access until the merchant period end. Cancellation jobs survive restart.

## Payments and structured email

Paid MCP tools prepare `AWAITING_PAYMENT` actions with exact invoice instructions. They do not bypass consumer wallet policy. The trusted executor makes the approved sandbox payment, and the merchant independently verifies the capture, invoice, amount, currency and payee. Capture responses without a payee are checked against their owning order. A client-provided completed status is never accepted.

`POST /webhooks/paypal` verifies the event signature through PayPal, then independently verifies its capture. Alternatively, a trusted executor calls `POST /internal/payments` with the action ID, capture ID and optional owning order ID. Internal routes require a distinct admin token; no MCP tool can assert payment completion.

Verified completion produces a durable outbox intent with both human text and a `mailbox.service-event.v1` JSON payload. The email worker sends it through the chosen provider and acknowledges the actual message ID. Queueing a receipt is distinct from successful delivery.

The controlled demo shares a trusted deployment for consumer orchestration and the fixture merchant's payment adapter. A real merchant must keep its own credentials, authenticate customer/service scopes, and integrate an appropriate payment authorization/delegation path. This package is not a new protocol or a completed multi-party payment platform.
