# Pigeon hosted demo

Service: https://mailbox-hackathon.onrender.com
Render service: srv-dbq7b70m7kps73ab3580
Repository: https://github.com/Hyunkim95/mailbox

The owner authorized publishing the latest code, deploying it to this existing service and verifying judge access. Do not create another service, increase capacity or alter the three-inbox cap.

## Configuration

The service runs one Node instance with its existing persistent disk. Both SQLite database paths remain under /var/data/mailbox. Keep the existing APP_SESSION_SECRET, access key and merchant credentials stable. Automatic deployments remain off; deploy an exact reviewed commit.

Build: npm ci --include=dev && npm run build
Start: npm start -- --hostname 0.0.0.0

APP_URL is the public HTTPS origin. MCP calls use the same service. The selected model provider, AgentMail, PayPal sandbox and Channel3 must be configured. The normal worker runs every 15 seconds. The PayPal capture webhook and AgentMail received-message webhook remain on their existing public routes.

## State migration

Preserve the original hosted workspace and paid Reel records. Back up both hosted databases before importing the connected Shopping workspace. Keep original actor IDs, addresses, capture IDs, invoices, approved limits and expiry dates. Never present retired Dev payments as new Shopping purchases.

Direct SSH access was rejected for this machine's registered keys. The deployment instead used Render's private secret files for a one-time startup import before the web server and worker started. Both hosted databases were backed up first. The import preserved Reel's original connection and capture byte for byte, merged Shopping and archived Dev records, and granted no new spending permission. It exposed no public restore endpoint. Temporary private files and the import startup command are removed during the final release.

Keep the hosted encryption key unchanged. Any imported token must remain bound to its original agent and wallet; no new spending permission or allowance is granted by deployment. Shopping's authorized USD 36.49 is fully spent, with no reserved or available funds.

## Acceptance

Before submission, verify the public Pigeon title and sign-in, the dedicated judge key, the exact Shopping and Reel identities, both new Shopping captures and original invoices, merchant receipt matching, a read-only native request, Channel3 discovery, dashboard availability and persistence after restart. Confirm the complete environment configuration and remove all transfer files.

Public acceptance on 12 November 2026 passed: Pigeon branding, a fresh browser sign-in with the dedicated key, both original Shopping captures and readable invoices, two native receipt matches, Reel's original active month and disabled renewal, eight genuine Channel3 results, and the populated AG Studio dashboard. Shopping remains at USD 36.49 spent and zero available/reserved. The existing receiver was updated to include Shopping while retaining Reel and its signing secret. Final release verification checks persistence after the cleanup deployment.

## Judge access

Supply the dedicated access key privately through Devpost's testing field, not the public repository. Explain that this is shared demo data. Judges need not make another payment: existing genuine sandbox outcomes, receipts and budgets are available for inspection.

Keep the app and necessary provider access available through 15 December 2026. Setup instructions are a fallback if hosting is unavailable. The official requirements are at https://paypalaihackathon.devpost.com/rules.
