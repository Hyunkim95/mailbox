import type { Proposal } from "../src/app-model";

export const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value / 100,
  );

export const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "Asia/Dubai",
  });

/** "Daily Paws <offers@example.com>" becomes "Daily Paws". */
export const senderName = (from: string) =>
  from.replace(/\s*<[^>]*>\s*$/, "").trim() || from;

export {
  digestFor,
  isExpiredOffer,
  needsYou,
  proposalBelongs,
  walletBelongs,
  type Digest,
  type Need,
} from "../src/queue";

export const proposalVerb = (proposal: Proposal) =>
  proposal.kind === "subscribe"
    ? "wants to subscribe"
    : proposal.kind === "book"
      ? "wants to book"
      : proposal.kind === "condition"
        ? "wants to set a price rule"
        : "wants to buy";

export const proposalPrice = (proposal: Proposal) =>
  proposal.kind === "condition"
    ? `Below ${money(proposal.condition_under ?? 3000)}`
    : money(proposal.amount);

export const proposalPriceLabel = (proposal: Proposal) =>
  proposal.kind === "subscribe"
    ? "one paid month, no renewal"
    : proposal.kind === "book"
      ? "booking deposit"
      : proposal.kind === "condition"
        ? "one purchase, exact variant"
        : "all-in total";
