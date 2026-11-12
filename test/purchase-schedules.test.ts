import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyDue,
  nextMonthlyDue,
  makeMonthlySchedule,
  scheduledPurchaseId,
} from "../src/purchase-schedules.ts";
import type { MonthlyPurchaseRule } from "../src/app-model.ts";
import { Merchant } from "@mailbox/service-sdk";
import { catalogue } from "../src/catalogue.ts";

function rule(patch: Partial<MonthlyPurchaseRule> = {}): MonthlyPurchaseRule {
  return {
    timezone: "Asia/Dubai",
    day_of_month: 12,
    local_time: "09:00",
    starts_at: "2026-11-12T05:00:00Z",
    expires_at: "2027-12-31T23:59:00Z",
    max_amount_minor: 3000,
    price_inclusive: false,
    item: { name: "Exact item", terms: "Delivered" },
    approved_at: null,
    ...patch,
  };
}
test("monthly boundaries use the selected zone, clamp shorter months and never catch up missed months", () => {
  assert.equal(
    monthlyDue(rule(), new Date("2026-11-12T04:59:59Z")).eligible,
    false,
  );
  const due = monthlyDue(rule(), new Date("2026-11-12T05:00:00Z"));
  assert.equal(due.eligible, true);
  assert.equal(due.period, "2026-11");
  assert.equal(
    monthlyDue(rule(), new Date("2027-01-20T05:00:00Z")).period,
    "2027-01",
  );
  assert.equal(
    nextMonthlyDue(rule(), new Date("2026-11-12T05:00:00Z"), true),
    "2026-12-12T05:00:00.000Z",
  );
  const end = rule({
    timezone: "UTC",
    day_of_month: 31,
    local_time: "10:00",
    starts_at: "2026-01-01T00:00:00Z",
  });
  assert.equal(
    monthlyDue(end, new Date("2027-02-28T10:00:00Z")).at,
    "2027-02-28T10:00:00.000Z",
  );
  assert.equal(
    monthlyDue(rule(), new Date("2028-01-01T00:00:00Z")).eligible,
    false,
  );
  assert.equal(nextMonthlyDue(rule(), new Date("2028-01-01T00:00:00Z")), null);
  assert.equal(
    nextMonthlyDue(
      rule({ expires_at: "2026-11-20T00:00:00Z" }),
      new Date("2026-11-21T00:00:00Z"),
    ),
    null,
  );
});
test("DST gaps move forward and repeated local times select the earlier instant", () => {
  const gap = rule({
    timezone: "America/New_York",
    day_of_month: 8,
    local_time: "02:30",
    starts_at: "2026-01-01T00:00:00Z",
  });
  assert.equal(
    monthlyDue(gap, new Date("2026-03-08T08:00:00Z")).at,
    "2026-03-08T07:30:00.000Z",
  );
  const fold = rule({
    timezone: "America/New_York",
    day_of_month: 1,
    local_time: "01:30",
    starts_at: "2026-01-01T00:00:00Z",
  });
  assert.equal(
    monthlyDue(fold, new Date("2026-11-01T07:00:00Z")).at,
    "2026-11-01T05:30:00.000Z",
  );
});
test("schedule preparation validates dates and supported products, with stable unique purchase identities", () => {
  const now = new Date("2026-11-11T12:00:00Z"),
    merchant = new Merchant(":memory:", catalogue.services, "maya", () => now);
  try {
    const quote = merchant.quote("basil-market", "coffee-250g", 1);
    const { item: _item, approved_at: _approved, ...input } = rule();
    const prepared = makeMonthlySchedule(quote, input, now);
    assert.equal(prepared.item.name, quote.item_name);
    assert.equal(prepared.approved_at, null);
    assert.throws(
      () =>
        makeMonthlySchedule(quote, { ...input, timezone: "Unknown/Zone" }, now),
      /timezone/,
    );
    assert.throws(
      () =>
        makeMonthlySchedule(
          quote,
          { ...input, expires_at: "2026-01-01T00:00:00Z" },
          now,
        ),
      /future schedule expiry/,
    );
    assert.throws(
      () =>
        makeMonthlySchedule(
          quote,
          {
            ...input,
            expires_at: "2026-11-12T04:00:00Z",
            starts_at: now.toISOString(),
          },
          now,
        ),
      /first eligible/,
    );
    assert.throws(() =>
      makeMonthlySchedule(
        merchant.quote("coast-screen", "monthly", 1),
        input,
        now,
      ),
    );
    assert.equal(
      scheduledPurchaseId("parent", "2026-11"),
      scheduledPurchaseId("parent", "2026-11"),
    );
    assert.notEqual(
      scheduledPurchaseId("parent", "2026-11"),
      scheduledPurchaseId("parent", "2026-12"),
    );
    assert.notEqual(
      scheduledPurchaseId("parent", "2026-11"),
      scheduledPurchaseId("other", "2026-11"),
    );
  } finally {
    merchant.close();
  }
});
