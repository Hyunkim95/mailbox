# Mailbox submission draft

Status: the local build and fixture checks pass. Complete the live acceptance run in [DEPLOYMENT.md](DEPLOYMENT.md), add the actual demo/video URLs and judges' access details, then revise the validation paragraph before submitting. No entry has been submitted.

## Project description

Mailbox gives each agent an email address and a workspace for the services its user chooses. Each connected service has its own wallet with limits. It helps people find useful offers and manage purchases and subscriptions without giving an agent unrestricted spending authority.

Maya wants to watch The Lantern Coast. Mailbox compares three invented streaming services, prepares one paid month with renewal disabled, and asks her to review the exact price and wallet permission. The PayPal sandbox adapter handles saved payment consent and charging; the merchant independently verifies the capture before activating access. The dashboard keeps the service, payment, confirmation message and cancellation date together.

The same loop supports coffee pack comparisons, restaurant deposits and a one-time pet-food price rule. Email provides offers, receipts and renewal context. MCP tools provide current catalogue data, quotes and merchant actions. A service does not need an integration for its email to be useful; direct actions require the capabilities it actually exposes.

PayPal is central to execution. Each service has its own spending mandate, with weekly or monthly limits, a per-action cap, expiry, configurable approval behavior and revocation. A wallet is a spending limit, not a prefunded PayPal balance. Uncertain payments keep their budget reservation, and retries reuse the same payment identity. Subscription admission prevents a second charge while the same service's access or payment remains active.

The model interprets requests and extracts typed email facts. It cannot grant permission, choose a payee or turn an email into proof of payment. Raw email extraction has no action tools. Image-only content is flagged unread rather than assigned invented facts.

Channel3 supplies live product search and retailer offers under the selected agent. Retailer links do not enforce checkout identity or establish a completed purchase. AG Studio renders each agent’s data and previews natural-language dashboard changes, saved separately for that agent. Neither integration can change spending permission.

The reference merchants use a thin TypeScript SDK over MCP and PayPal. Adding a service with an existing subscription, purchase or booking capability is a new configuration. The demo uses this SDK itself; no outside merchant adoption is claimed.

Built with Next.js, TypeScript, SQLite, the official MCP SDK, PayPal sandbox Vault and Orders APIs, OpenAI or Claude structured outputs and AgentMail. All merchant names, products, film and fixture messages are invented. At this checkpoint, 51 core tests and twelve browser scenarios pass using real MCP calls and injected provider responses. Real OpenAI request interpretation and email extraction passed a direct API check. Two real AgentMail agent addresses were created, and 12 controlled streaming and grocery sample emails were delivered and ingested. These are fixture content, not payment evidence. The account’s three-inbox quota currently prevents Table and Paws from receiving their own addresses; their messages remain labeled previews. PayPal accepted a real sandbox setup-token request and returned its buyer approval step. No saved payment token or real sandbox charge has been verified. Real Anthropic and hosted acceptance remain pending.

## Recording plan

Target 2:45. Record actual application operation after live acceptance. Keep cuts visible where a provider wait is shortened, and retain the matching real payment and message evidence. Use the invented assets and original narration.

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00 to 0:20 | Before Mailbox inbox, then Reel’s agent workspace and address | “Maya's services keep sending offers and renewal notices. She wants to watch one film, but finding the right service and remembering the payment are separate jobs. Mailbox gives her agents a home for their services, messages and decisions.” |
| 0:20 to 0:40 | In Reel, type the film request, compare three options, choose one month | “Maya asks Reel for The Lantern Coast. Her agent checks the services through MCP and compares the current options. Maya chooses one month, with renewal disabled.” |
| 0:40 to 1:00 | Wallet permission and actual sandbox consent | “Every service gets its own wallet. Maya sets its spending limit and approval rules, then connects PayPal in the sandbox.” |
| 1:00 to 1:20 | Actual capture, service row, received email and cancellation date | “The service activates after payment is independently verified. Its address, confirmation, wallet debit and cancellation date stay together.” |
| 1:20 to 1:35 | Coffee comparison, source email, approved purchase and receipt | “For coffee, the agent compares current pack prices per kilogram, checks stock and ignores expired offers.” |
| 1:35 to 1:50 | Friday table, deposit proposal and confirmed booking | “For dinner, it checks an available table and shows the exact deposit before booking.” |
| 1:50 to 2:05 | Exact pet-food rule, one capture and receipt | “For pet food, Maya can approve a one-time purchase below her chosen price. That rule applies to this exact item.” |
| 2:05 to 2:25 | Upsell message, quiet decline, wallet ledger | “An email cannot expand that permission. The upgrade stays unapproved, and Maya can see the decision or disconnect spending.” |
| 2:25 to 2:35 | SDK configuration beside the resulting service | “Our invented merchants use a small SDK over MCP and PayPal. Here is how another supported service would integrate.” |
| 2:35 to 2:45 | Agent workspaces, a saved AG Studio dashboard, and distinct service wallets | “An address for each agent. A separate wallet for each service. Help with the jobs you choose, within the limits you set.” |

## Final entry fields

- Public MIT repository URL: https://github.com/Hyunkim95/mailbox.
- Functional demo URL and dedicated judge login: pending hosting and live acceptance.
- Public YouTube URL: pending recording and upload.
- Team identity and entrant declarations: owner-provided fields.
- Payment/email/model evidence: pending real-provider run; do not replace with fixture screenshots.

The [official rules](https://paypalaihackathon.devpost.com/rules) set the deadline at noon PST on 12 November 2026, midnight entering 13 November in Dubai. They require public licensed source, a working build, English materials and a public YouTube demo below three minutes. Provide the required access details for judging through 15 December.
