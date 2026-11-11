# Mailbox submission draft

Status: the local build and fixture checks pass. Complete the live acceptance run in [DEPLOYMENT.md](DEPLOYMENT.md), add the actual demo/video URLs and judges' access details, then revise the validation paragraph before submitting. No entry has been submitted.

## Project description

Mailbox gives each agent an email address and a workspace for the services its user chooses. Each connected service has its own wallet with limits. It helps people find useful offers and manage purchases and subscriptions without giving an agent unrestricted spending authority.

Maya wants to watch The Lantern Coast. Mailbox compares three invented streaming services, prepares one paid month with renewal disabled, and asks her to review the exact price and wallet permission. The PayPal sandbox adapter handles saved payment consent and charging; the merchant independently verifies the capture before activating access. The dashboard keeps the service, payment, confirmation message and cancellation date together.

The same loop supports coffee pack comparisons, restaurant deposits and a one-time pet-food price rule. Email provides offers, receipts and renewal context. MCP tools provide current catalogue data, quotes and merchant actions. A service does not need an integration for its email to be useful; direct actions require the capabilities it actually exposes.

PayPal is central to execution. Each service has its own spending mandate, with weekly or monthly limits, a per-action cap, expiry, configurable approval behavior and revocation. A wallet is a spending limit, not a prefunded PayPal balance. Uncertain payments keep their budget reservation, and retries reuse the same payment identity. Subscription admission prevents a second charge while the same service's access or payment remains active.

The model interprets requests and extracts typed email facts. It cannot grant permission, choose a payee or turn an email into proof of payment. Raw email extraction has no action tools. Image-only content is flagged unread rather than assigned invented facts.

Channel3 supplies live product search and retailer offers under the selected agent. Retailer links do not enforce checkout identity or establish a completed purchase. The local prototype uses AG Studio to render each agent’s data and preview natural-language dashboard changes, saved separately for that agent. The hosted core build excludes AG Studio while its licence is deferred; the video labels dashboard footage as local. Neither integration can change spending permission.

The reference merchants use a thin TypeScript SDK over MCP and PayPal. Adding a service with an existing subscription, purchase or booking capability is a new configuration. The demo uses this SDK itself; no outside merchant adoption is claimed.

Built with Next.js, TypeScript, SQLite, the official MCP SDK, PayPal sandbox Vault and Orders APIs, OpenAI or Claude structured outputs and AgentMail. All merchant names, products, film and fixture messages are invented. At this checkpoint, 53 core tests and fourteen browser scenarios pass using real MCP calls and injected provider responses. Real OpenAI request interpretation and email extraction passed a direct API check. Two real AgentMail agent addresses were created, and 12 controlled streaming and grocery sample emails were delivered and ingested. These are fixture content, not payment evidence. The approved demo uses Reel and Pantry as its two live email agents. Table and Paws remain explicitly labeled fixture walkthroughs; no live paid execution or received confirmation is claimed for them. PayPal accepted a real sandbox setup-token request and returned its buyer approval step. No saved payment token or real sandbox charge has been verified. Real Anthropic and hosted acceptance remain pending.

## Recording plan

Target 2:50. Record actual application operation after live acceptance. Keep cuts visible where a provider wait is shortened, and retain the matching real payment and message evidence. Payment and activation scenes are conditional on successful real-provider validation. Use the invented assets and original narration.

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00 to 0:18 | Before Mailbox inbox, then named agent cards and Reel’s address | “Maya’s services keep sending offers and renewal notices. She wants to watch one film, find a coffee deal, and keep track of what she buys. Mailbox gives her agents a home for their services, messages and decisions.” |
| 0:18 to 0:36 | In Reel, type the film request, compare MCP options and choose one month | “Maya asks Reel for The Lantern Coast. Her agent checks three invented services through MCP and compares current prices and terms. She chooses one month of Coast Screen, with renewal disabled.” |
| 0:36 to 0:54 | Show acting agent, alias, independent service wallet and actual sandbox consent | “The purchase belongs to Reel and uses Reel’s address. Each service has its own wallet. Maya controls the spending cap, expiry and approval rules, then connects PayPal in the sandbox.” |
| 0:54 to 1:12 | Verified capture, merchant activation, received confirmation and cancellation date | “The merchant verifies the payment before activating access. Mailbox keeps the exact charge, received confirmation and cancellation date together. Retries retain the same payment identity, so an uncertain response does not start another purchase.” |
| 1:12 to 1:25 | Pantry coffee pack comparison, expired offer, native HTML source and selected proposal | “Pantry compares coffee by price per kilogram, checks current stock and excludes expired offers. Its newsletter reader keeps the checkout discount separate from advertised future cashback.” |
| 1:25 to 1:35 | Table’s fixture walkthrough: Friday availability and exact deposit, with preview labeling | “The fixture walkthrough also shows a Friday table and its exact deposit before any booking is confirmed.” |
| 1:35 to 1:47 | Paws’s fixture walkthrough: exact product, threshold and proposed one-time rule | “A second fixture walkthrough shows a one-time rule for an exact pet-food variant below Maya’s chosen price. Live execution still requires payment permission.” |
| 1:47 to 2:00 | Agent-scoped Channel3 search for headphones, actual priced offers and retailer links | “For a wider search, Channel Three returns real product offers. These retailer links are discovery handoffs. This build does not claim an automated purchase at those retailers.” |
| 2:00 to 2:18 | Local prototype, explicitly labeled: AG Studio layout preview, changed chart and saved agent dashboard | “Each agent has its own dashboard. With A G Studio, Maya can ask for a different view of spending, messages or decisions. She previews the result and saves it for that agent. Dashboard edits cannot change payment permission.” |
| 2:18 to 2:30 | Malicious or upsell sample, no resulting charge, wallet activity and disconnect control | “An email cannot grant spending authority. An unrequested upgrade stays unapproved. Maya can inspect the source, review the wallet’s activity, pause it or disconnect its payment permission.” |
| 2:30 to 2:40 | SDK configuration alongside its actual fixture MCP tools | “Our invented merchants use a small SDK over MCP and PayPal. Supported services share the same catalogue, payment and structured confirmation code.” |
| 2:40 to 2:50 | Agent cards, reusable addresses and distinct service wallets | “An address for each agent. A separate wallet for each service. Help with the jobs you choose, within the limits you set.” |

## Final entry fields

- Public MIT repository URL: https://github.com/Hyunkim95/mailbox.
- Functional demo URL and dedicated judge login: pending hosting and live acceptance. The dedicated key reopens one shared Maya workspace, retaining Reel and Pantry’s addresses; disclose that key holders share its demo data and wallet settings.
- Public YouTube URL: pending recording and upload.
- Team identity and entrant declarations: owner-provided fields.
- Payment/email/model evidence: pending real-provider run; do not replace with fixture screenshots.

The [official rules](https://paypalaihackathon.devpost.com/rules) set the deadline at noon PST on 12 November 2026, midnight entering 13 November in Dubai. They require public licensed source, a working build, English materials and a public YouTube demo below three minutes. Provide the required access details for judging through 15 December.
