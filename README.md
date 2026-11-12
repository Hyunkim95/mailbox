# Pigeon

Public repository: [Hyunkim95/mailbox](https://github.com/Hyunkim95/mailbox). This project's original code uses the [MIT license](LICENSE), an [OSI-approved license](https://opensource.org/license/mit). The repository retains its original internal name; the product is Pigeon.

Pigeon gives personal agents their own inboxes, service connections and spending rules. Agents compose reusable capabilities to read mail, search documents, compare current quotes, track work, prepare sourced replies and propose supported purchases.

The owner reviews financial permission. PayPal handles saved-payment consent and charges; the server checks identity, limits, quote expiry and idempotency before execution. Each agent and service keeps its own records.

## Try the demo

Hosted demo: https://mailbox-hackathon.onrender.com

Use the dedicated access key supplied privately in the Devpost testing instructions. This opens a shared judging workspace. The public Pigeon build has passed dedicated-key sign-in, receipt matching, original merchant-status checks, Channel3 discovery and dashboard loading. See DEPLOYMENT.md.

Shopping uses its own genuine AgentMail address. Its USD 6.50 coffee purchase and one automatically scheduled USD 29.99 refill completed through PayPal's sandbox, and their original emailed invoices were received and matched. Reel retains its original USD 7.99 paid month, renewal-disabled status and receipt. Historical transactions remain under their original identities.

The reference shops, products and correspondence are fictional. PayPal, AgentMail, the model and Channel3 calls used for the connected acceptance are genuine provider APIs. No real money or goods move. Channel3 provides retailer discovery and handoff links, not universal checkout. Text documents can be read; image-only or unsupported attachments remain missing evidence.

The demonstrated Shopping allowance is exhausted. Judges can inspect existing outcomes and use read-only requests without making another purchase. A new payment needs fresh owner-controlled limits and PayPal permission. The provider account is capped at three inboxes; existing connected agents can be reused.

## Run locally

Requires Node 24 or later and npm.

```sh
git clone https://github.com/Hyunkim95/mailbox.git
cd mailbox
npm ci
npm run setup:local
```

The setup command creates a private .env from [.env.example](.env.example) and generates the app, merchant and demo-login secrets. Add your provider credentials there, then start the app:

```sh
npm run dev
```

Open the printed local URL and sign in with the private DEMO_ACCESS_KEY generated in .env. Local setup preserves existing credentials. Never commit .env. A fresh local installation has its own workspace; the connected hosted demo's private mail and payment databases are not distributed with the source.

For a production build with the normal scheduled worker:

```sh
npm run build
npm start
```

Configure APP_URL to the HTTPS origin. Keep APP_DATABASE_PATH and MOCK_DATABASE_PATH on persistent storage, run one instance, and retain APP_SESSION_SECRET for encrypted payment tokens. See .env.example and DEPLOYMENT.md.

For model-backed requests, configure AI_PROVIDER and its matching OPENAI_API_KEY or ANTHROPIC_API_KEY. Add AgentMail, PayPal sandbox and Channel3 credentials for their respective capabilities. Empty credentials produce explicit configuration messages; previews are labeled and do not establish provider delivery or payment.

| Capability | Configuration |
| --- | --- |
| Natural-language agents | AI_PROVIDER=openai with OPENAI_API_KEY, or AI_PROVIDER=anthropic with ANTHROPIC_API_KEY. OPENAI_MODEL and ANTHROPIC_MODEL are optional overrides. |
| PayPal consent and payments | PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_MERCHANT_ID from the same sandbox business application/account. PAYPAL_WEBHOOK_ID identifies its registered capture webhook. |
| Agent inboxes and email | AGENTMAIL_API_KEY; AGENTMAIL_WEBHOOK_SECRET verifies incoming webhook signatures. Provider inbox limits still apply. |
| Retailer discovery | CHANNEL3_API_KEY. |
| Hosting | APP_URL, persistent database paths and stable private app/merchant secrets; see [DEPLOYMENT.md](DEPLOYMENT.md). RENDER_API_KEY is an optional deployment-management credential, not required to run locally. |

## How PayPal is used

PayPal is central to the action workflow. The owner first reviews the exact proposal, agent identity and service-specific spending permission. The sandbox Vault API creates a setup token, sends the buyer through genuine PayPal consent and exchanges the approved setup for a saved payment token. Tokens remain encrypted on the server and bound to that service wallet.

For an authorized purchase, the server reserves the amount against both wallet limits and the agent's total allowance. It creates and captures a PayPal Orders API order with the merchant action's invoice reference. The reference merchant independently verifies the capture, amount, USD currency, invoice and payee before confirming the action and producing its receipt. Signed capture webhooks and idempotent request identities support reconciliation when a response is lost.

The monthly refill uses the same checks and executor from the normal background worker. Approving the standing rule does not itself charge; a due purchase must pass the saved boundaries again. A reference subscription is one paid month with renewal disabled, not an indefinitely renewing PayPal billing subscription.

Implementation: [PayPal client](src/paypal.ts), [approval and execution](src/app-service.ts), [wallet admission and ledger](src/app-store.ts), [merchant capture verification](packages/service-sdk/src/payments.ts) and [merchant lifecycle](packages/service-sdk/src/merchant.ts).

## How AI is used

The hosted demonstration and connected acceptance use OpenAI. The same agent interface also supports Anthropic/Claude when configured; a real Anthropic acceptance run is not claimed.

The model chooses sequential capabilities at runtime: search and read this agent's emails and documents, inspect existing services, obtain current MCP quotes, compare offers, track a checklist, and prepare a reply, purchase, cancellation review or monthly rule. Incoming email extraction and dashboard customization also use model-backed calls. The server validates tool arguments, evidence references and access boundaries. Preparing a review never lets the model grant itself payment permission or send a reply on its own.

Implementation: [model adapters](src/agent-model.ts), [shared capability registry and instructions](src/agent-tools.ts), [validated agent loop](src/agent-run.ts), [email extraction](src/ai.ts) and [dashboard model integration](src/studio-model.ts).

## Other technologies and sponsor integrations

| Tool | How the project uses it | Source |
| --- | --- | --- |
| AgentMail | Creates and reuses actual agent addresses; sends and receives email and original attachments. | [Email integration](src/email.ts) |
| Model Context Protocol and our service SDK | Exposes reference merchant catalogues, quotes and supported action/status tools over authenticated MCP HTTP. | [Service SDK](packages/service-sdk/README.md), [MCP client](src/service-connector.ts) |
| AG Studio / AG Grid | Renders agent-scoped grids and charts; previews model-generated dashboard changes and saves the reviewed layout. Third-party evaluation branding is retained. | [Dashboard](app/niche-dashboard.tsx), [studio integration](src/studio-model.ts) |
| Channel3 | Searches its real product catalogue and displays retailer prices, images and offer links, with affiliate disclosures. These are discovery handoffs, not Pigeon checkout integrations. | [Market search](src/market.ts) |
| Render | Hosts the public Node app, MCP routes, webhooks and background worker, using the existing persistent disk for SQLite state. | [Deployment guide](DEPLOYMENT.md), [Blueprint](render.yaml) |
| Next.js, React, TypeScript and Node.js | Implement the interactive product UI, authenticated APIs and server-side orchestration. | [App](app/), [server](src/) |
| SQLite | Persists scoped agents, evidence, permissions, financial reservations, actions and the merchant outbox. | [App store](src/app-store.ts), [merchant store](packages/service-sdk/src/merchant.ts) |
| unpdf and Cheerio | Extract readable PDF text and normalize email HTML. Unsupported or unread content remains explicit missing evidence. | [Documents](src/documents.ts), [email content](src/email-content.ts) |
| Playwright and Node's test runner | Exercise the browser workflows and server/SDK invariants separately from genuine-provider acceptance. | [Browser tests](browser-tests/), [core tests](test/) |

## Reusable capabilities

The model selects tools at runtime. Accountant, shopping, travel and subscription requests use the same evidence, planning and review capabilities. Email content cannot grant authority. The server enforces owner and agent boundaries, source validation, payment admission, reconciliation and exactly-once scheduled purchases.

Reference merchants use the TypeScript service SDK in packages/service-sdk over authenticated MCP HTTP. Adding a merchant with supported purchase, subscription or booking abilities is configuration, not a scenario-specific agent script. Outside merchant adoption is not claimed.

Agent dashboards use AG Studio and can be customized and saved per agent. The owner confirmed with the hackathon organizers that a license key is not required for this build. NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY remains optional; third-party evaluation branding is retained.

## Verify

```sh
npm test
npm run test:browser
npm run format:check
```

Latest completed local acceptance: 96 core checks and 32 browser scenarios. Core and browser tests use isolated provider transports; connected acceptance separately verified genuine provider outcomes. No test result alone is presented as a payment or email-delivery result.

## Submission

Public source: https://github.com/Hyunkim95/mailbox. The repository retains its original internal name; the product is Pigeon.

SUBMISSION.md contains the current entry copy and outstanding video link. API credentials, buyer passwords, private mail archives and production databases are excluded from this repository.

MIT licensed for this project's own code. Third-party SDKs retain their own licenses. The service SDK is a workspace package, not a published merchant network.
