# Hosted demo

The repository includes a [Render Blueprint](render.yaml) for one Node service with a 1 GB persistent disk. It is prepared configuration, not a deployed service. Creating it provisions paid compute and storage. The disk keeps both SQLite databases across restarts; do not scale the service to multiple instances. [Render disk constraints](https://render.com/docs/disks).

1. Publish the reviewed source to its public MIT-licensed repository, then create a Blueprint from that repository. Keep automatic deployments off during recording and judging.
2. Fill the service credentials requested by the Blueprint. Select `AI_PROVIDER=openai` or `anthropic`, then add the matching `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the service environment. Only the chosen model provider needs a key. Also add `CHANNEL3_API_KEY` and a valid `NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY` including AI before the build. Set `APP_URL` to the service's actual HTTPS origin, with no trailing path. Leave `MOCK_MERCHANT_URL` unset so MCP calls use the same server's loopback port. Do not copy the local `.env` wholesale.
3. Keep the four generated private secrets stable. Changing `APP_SESSION_SECRET` makes existing encrypted payment tokens unreadable. Get the hosted `DEMO_ACCESS_KEY` from Render's environment settings and provide it in the judges' testing instructions.
4. In the sandbox PayPal application's webhook settings, register `https://<actual-host>/webhooks/paypal` for `PAYMENT.CAPTURE.COMPLETED`. Save its ID as `PAYPAL_WEBHOOK_ID` on the service. This is a sandbox app and a matching sandbox merchant account, never live credentials.
5. Create an AgentMail webhook for the owned inboxes at `https://<actual-host>/api/webhooks/agentmail`, subscribing to `message.received`. Save its signing secret as `AGENTMAIL_WEBHOOK_SECRET`. Confirm inbox capacity before provisioning the four consumer addresses and merchant sender.
6. Deploy and open the hosted URL. Check both database paths are under `/var/data/mailbox`, sign in, and complete the live acceptance steps below. Restart once and confirm the service, ledger and cancellation still exist.

Blueprint secrets are prompted on initial creation; later secret changes must be added to the service directly. Generated values are retained when already present. [Render Blueprint reference](https://render.com/docs/blueprint-spec).

## Live acceptance before recording

Use only the owned sandbox accounts and invented merchant data. Record actual provider references privately; do not commit tokens or mailbox credentials.

- Send the 24 fixture emails through **Demo setup**. Confirm actual delivery in **Service messages** and a matching source dialog, with no preview substituted for receipt.
- Submit a typed film request. Confirm model-backed interpretation, the three service options and their MCP quotes. Choose one month, save the wallet permission, approve PayPal's sandbox consent, and follow its return.
- Verify the completed capture in PayPal, the independent merchant activation, exactly one wallet debit, actual confirmation email, and the paid period's cancellation date. Measure approval return to the complete service/email state; the target is 15 seconds, not an achieved claim.
- Reload and retry synchronization. Confirm no second capture. Pause and disconnect a service, then check that a new action cannot spend. Reconnection must require fresh permission.
- Compare coffee pack prices and source email, purchase the selected variant, and verify its real capture and receipt. Book the displayed Friday table and verify a paid deposit and confirmation.
- Approve the exact dog-food rule below $30. Verify it fires only once when its current quote qualifies and never buys another variant. Check its capture and receipt.
- Confirm the upsell does not change authority or spend. Reset, verify old authority is disabled and historical PayPal payments still exist, then replay without reusing a completed payment identity as a new charge.

## Judging handoff

Provide the actual URL, a dedicated demo login and sandbox buyer instructions through the submission's testing fields. Keep API secrets out of the public repository. Leave the demo available through 15 December 2026, including the background worker and receiving webhooks. The [official rules](https://paypalaihackathon.devpost.com/rules) allow setup instructions or hosting, require public licensed source and a public YouTube demonstration under three minutes, and require a functioning build matching the claims.
