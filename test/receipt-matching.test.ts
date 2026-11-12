import { test } from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/app-store.ts";
import { confirmationMatch } from "../src/receipt-matching.ts";
import { explicitCurrency } from "../src/email-content.ts";
import type { Message } from "../src/app-model.ts";

test("receipt correlation requires reference, exact amount, explicit currency and the scoped recipient", () => {
  const store = new AppStore(":memory:");
  try {
    const agent = store.createAgent("owner", {
      name: "Project",
      purpose: "Project records",
    });
    agent.email = "project@example.test";
    agent.inbox_id = "project-inbox";
    const paid = {
      id: "payment",
      agent_id: agent.id,
      service_id: "supported-service",
      status: "PAID" as const,
      capture_id: "capture",
      merchant_action_id: "action-reference",
      amount: 799,
    };
    const m: Message = {
      id: "receipt",
      owner: "owner",
      agent_id: agent.id,
      service_id: paid.service_id,
      provider_id: "project-inbox:receipt",
      from: "Merchant <merchant@example.test>",
      recipients: ["Project <project@example.test>"],
      subject: "Confirmation",
      text: "USD 7.99 paid. Reference action-reference.",
      received_at: store.now().toISOString(),
      kind: "confirmation",
      origin: "agentmail",
      facts: {
        item: "Plan",
        amount_minor: 799,
        currency: "USD",
        action_id: paid.merchant_action_id,
        expires: null,
        suspicious: false,
      },
    };
    assert.equal(confirmationMatch(m, agent, [paid]).status, "matched");
    assert.equal(
      confirmationMatch({ ...m, recipients: ["other@example.test"] }, agent, [
        paid,
      ]).status,
      "unverified",
    );
    assert.equal(
      confirmationMatch({ ...m, origin: "fixture_preview" }, agent, [paid])
        .status,
      "unverified",
    );
    assert.equal(
      confirmationMatch(
        {
          ...m,
          text: "CAD 7.99 paid. Reference action-reference.",
          facts: { ...m.facts, currency: "CAD" },
        },
        agent,
        [paid],
      ).status,
      "mismatch",
    );
    assert.equal(
      confirmationMatch(
        { ...m, text: "$7.99 paid. Reference action-reference." },
        agent,
        [paid],
      ).status,
      "ambiguous",
    );
    assert.equal(
      confirmationMatch(
        { ...m, text: "USD 7.99 / CAD 10.00. Reference action-reference." },
        agent,
        [paid],
      ).status,
      "ambiguous",
    );
    assert.equal(
      confirmationMatch(
        { ...m, facts: { ...m.facts, amount_minor: 1299 } },
        agent,
        [paid],
      ).status,
      "mismatch",
    );
    assert.equal(
      confirmationMatch(
        { ...m, text: "USD 7.99, no reliable reference." },
        agent,
        [paid],
      ).status,
      "unmatched",
    );
    assert.equal(
      confirmationMatch(m, agent, [{ ...paid, agent_id: "another-agent" }])
        .status,
      "unmatched",
    );
    assert.equal(
      confirmationMatch(m, agent, [{ ...paid, status: "NEEDS_APPROVAL" }])
        .status,
      "unmatched",
    );
    assert.equal(
      confirmationMatch(m, agent, [
        paid,
        { ...paid, id: "duplicate-payment-record" },
      ]).status,
      "ambiguous",
    );
    assert.equal(paid.amount, 799);
    assert.equal(paid.status, "PAID");
  } finally {
    store.close();
  }
});

test("explicit currency recognition does not infer a currency from a dollar sign or ordinary reference", () => {
  assert.equal(explicitCurrency('USD 7.99. {"currency":"USD"}'), "USD");
  assert.equal(explicitCurrency("7.99 USD"), "USD");
  assert.equal(explicitCurrency("$7.99"), null);
  assert.equal(explicitCurrency("Invoice INV 204, 11 November 2026"), null);
  assert.equal(explicitCurrency("USD 7.99 and CAD 7.99"), null);
});
