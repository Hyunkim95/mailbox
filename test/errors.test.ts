import { test } from "node:test";
import assert from "node:assert/strict";
import { MerchantError, isMerchantError } from "@mailbox/service-sdk";

test("domain errors survive separate module instances without trusting JSON error lookalikes", async () => {
  const copy = await import(
    new URL(
      "./definition.js?independent-instance",
      import.meta.resolve("@mailbox/service-sdk"),
    ).href
  );
  const error = new copy.MerchantError(
    "SETUP_REQUIRED",
    "Provider setup required",
  );
  assert.equal(error instanceof MerchantError, false);
  assert.equal(isMerchantError(error), true);
  assert.equal(
    isMerchantError({ code: "SETUP_REQUIRED", message: "untrusted" }),
    false,
  );
  assert.equal(isMerchantError(new Error("regular provider error")), false);
});
