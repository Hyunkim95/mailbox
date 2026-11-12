import { randomUUID } from "node:crypto";
import { MerchantError, type Action } from "@mailbox/service-sdk";
import type { AppStore } from "./app-store.ts";
import type { CancellationReview } from "./app-model.ts";
import {
  managedServiceStatus,
  serviceActionWallet,
} from "./managed-services.ts";
import { merchantTool } from "./service-connector.ts";

const key = (owner: string, id: string) => `cancellation-review:${owner}:${id}`;
function save(store: AppStore, review: CancellationReview) {
  store.setSetting(key(review.owner, review.id), review);
}
export function cancellationReview(store: AppStore, owner: string, id: string) {
  const review = store.setting<CancellationReview>(key(owner, id));
  if (!review || review.owner !== owner)
    throw new MerchantError(
      "NOT_FOUND",
      "That cancellation review is not available.",
    );
  return review;
}
export function cancellationReviews(store: AppStore, owner: string) {
  return store.db
    .prepare("SELECT body FROM settings WHERE key LIKE ?")
    .all(`cancellation-review:${owner}:%`)
    .map((row) => JSON.parse(row.body as string) as CancellationReview)
    .filter((r) => r.status !== "DISCARDED");
}

export async function prepareCancellationReview(
  store: AppStore,
  owner: string,
  agentId: string,
  ids: string[],
  effective: CancellationReview["effective"],
  rpc: typeof merchantTool<Action> = merchantTool<Action>,
) {
  store.agent(owner, agentId);
  if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length)
    throw new MerchantError(
      "INVALID_CANCELLATION",
      "Choose one to twenty distinct service actions.",
    );
  const entries: CancellationReview["entries"] = [];
  for (const id of ids) {
    const p = store.proposal(owner, id),
      wallet = serviceActionWallet(store, owner, agentId, p);
    if (p.history_source)
      throw new MerchantError(
        "LINKED_HISTORY_READONLY",
        "This historical payment is read-only. Manage its original service connection.",
      );
    if (p.kind !== "subscribe" || p.status !== "PAID" || !p.merchant_action_id)
      throw new MerchantError(
        "NOT_CANCELLABLE",
        "Choose paid, supported subscription actions. Unresolved payments need separate review.",
      );
    const status = await managedServiceStatus(store, owner, agentId, id, rpc);
    if (
      !status.payment_confirmed ||
      !status.identity_verified ||
      status.merchant_status !== "ACTIVE"
    )
      throw new MerchantError(
        "SERVICE_REVIEW_REQUIRED",
        "Current service access or payment identity could not be verified for cancellation.",
      );
    entries.push({
      proposal_id: p.id,
      wallet_id: wallet.id,
      merchant_action_id: p.merchant_action_id,
      service_id: p.service_id,
      title: p.title,
      amount: p.amount,
      period_end: status.period_end ?? null,
      renewal_already_disabled: status.renewal_disabled === true,
      status: "PENDING",
      effective_at: null,
      reason: null,
    });
  }
  const review: CancellationReview = {
    id: randomUUID(),
    owner,
    agent_id: agentId,
    revision: 1,
    effective,
    status: "DRAFT",
    confirmed_at: null,
    created_at: store.now().toISOString(),
    entries,
  };
  save(store, review);
  store.log(
    owner,
    "CANCELLATION_REVIEW_PREPARED",
    `${entries.length} supported services await owner review. Nothing has been cancelled.`,
    null,
    null,
    agentId,
  );
  return review;
}

// A live promise joins duplicate requests in the documented single-instance
// host. Durable SDK request identities also protect retries across restarts.
const running = new Map<string, Promise<CancellationReview>>();
export async function confirmCancellationReview(
  store: AppStore,
  owner: string,
  id: string,
  revision: number,
  rpc: typeof merchantTool<Action> = merchantTool<Action>,
) {
  const recordKey = key(owner, id),
    live = running.get(recordKey);
  if (live) return live;
  const review = store.transaction(() => {
    const r = cancellationReview(store, owner, id);
    store.agent(owner, r.agent_id);
    if (r.status === "DISCARDED")
      throw new MerchantError("REVIEW_CLOSED", "This review was discarded.");
    if (r.status === "COMPLETE") return r;
    if (!r.confirmed_at) {
      if (r.revision !== revision)
        throw new MerchantError(
          "REVIEW_CHANGED",
          "This review changed. Read the current consequences before confirming.",
        );
      r.confirmed_at = store.now().toISOString();
    }
    r.status = "RUNNING";
    r.revision++;
    save(store, r);
    return r;
  });
  if (review.status === "COMPLETE") return review;
  const work = (async () => {
    for (const entry of review.entries) {
      if (["ENDED", "SCHEDULED"].includes(entry.status)) continue;
      try {
        const p = store.proposal(owner, entry.proposal_id);
        serviceActionWallet(store, owner, review.agent_id, p);
        if (
          p.status !== "PAID" ||
          p.merchant_action_id !== entry.merchant_action_id
        )
          throw new MerchantError(
            "SERVICE_CHANGED",
            "The service action changed after review.",
          );
        // Reconcile first: a previous response may have been lost after execution.
        let status = await managedServiceStatus(
          store,
          owner,
          review.agent_id,
          p.id,
          rpc,
        );
        if (status.period_end !== entry.period_end)
          throw new MerchantError(
            "SERVICE_CHANGED",
            "The access end date changed after review. Prepare a fresh review before cancelling this item.",
          );
        const achieved = () =>
          review.effective === "immediate"
            ? status.merchant_status === "CANCELED" &&
              !!status.cancel_effective_at &&
              new Date(status.cancel_effective_at) <= store.now()
            : status.renewal_disabled === true &&
              !!status.cancel_effective_at &&
              status.cancel_effective_at === status.period_end;
        const alreadyAchieved = achieved();
        if (!alreadyAchieved) {
          try {
            await rpc(p.service_id, "cancel", {
              action_id: p.merchant_action_id,
              effective: review.effective,
              idempotency_key: `close-${review.id}-${p.id}`,
            });
          } catch {
            // A response failure is not evidence of either success or failure.
          }
          status = await managedServiceStatus(
            store,
            owner,
            review.agent_id,
            p.id,
            rpc,
          );
        }
        if (
          !status.payment_confirmed ||
          !status.identity_verified ||
          !achieved()
        )
          throw new MerchantError(
            "CANCELLATION_UNVERIFIED",
            "The requested merchant cancellation has not been verified.",
          );
        store.transaction(() => {
          const current = store.proposal(owner, p.id);
          current.cancel_effective_at = status.cancel_effective_at!;
          store.saveProposal(current);
        });
        entry.status = review.effective === "immediate" ? "ENDED" : "SCHEDULED";
        entry.effective_at = status.cancel_effective_at!;
        entry.reason = alreadyAchieved
          ? "The requested end state was already verified. No additional cancellation was issued."
          : review.effective === "immediate"
            ? "Merchant access ended. No refund was requested."
            : "Merchant cancellation scheduled for the verified access end date.";
        store.log(
          owner,
          "SERVICE_CANCELLATION_VERIFIED",
          entry.reason,
          p.service_id,
          null,
          review.agent_id,
        );
      } catch (error) {
        entry.status = "NEEDS_REVIEW";
        entry.reason =
          error instanceof MerchantError
            ? error.message
            : "The merchant outcome could not be verified. This item still needs attention.";
        store.log(
          owner,
          "SERVICE_CANCELLATION_UNRESOLVED",
          entry.reason,
          entry.service_id,
          null,
          review.agent_id,
        );
      }
      review.revision++;
      save(store, review);
    }
    review.status = review.entries.every((e) =>
      ["ENDED", "SCHEDULED"].includes(e.status),
    )
      ? "COMPLETE"
      : "PARTIAL";
    review.revision++;
    save(store, review);
    return review;
  })();
  running.set(recordKey, work);
  try {
    return await work;
  } finally {
    running.delete(recordKey);
  }
}

export function discardCancellationReview(
  store: AppStore,
  owner: string,
  id: string,
) {
  const review = cancellationReview(store, owner, id);
  if (review.confirmed_at)
    throw new MerchantError(
      "REVIEW_CONFIRMED",
      "This review was already confirmed. Inspect its individual results.",
    );
  review.status = "DISCARDED";
  review.revision++;
  save(store, review);
  return review;
}
