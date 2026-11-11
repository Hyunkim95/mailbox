import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readEmailContent,
  nativePromotionFacts,
} from "../src/email-content.ts";
test("image-heavy newsletter keeps its hidden preheader without fetching images", () => {
  const html =
    '<div style="display:none">Get 15% OFF + 15% Cashback on Demo Grocer Products. Use Code: DG15 - SAVE 30%!</div><img src="https://example.invalid/banner.jpg"><a href="https://example.invalid/unsubscribe?private=secret">Unsubscribe</a>';
  const content = readEmailContent({ html });
  assert.match(content.text, /DG15/);
  assert(!content.text.includes("private=secret"));
  assert.equal(content.images.length, 1);
  assert.equal(content.needsVision, false);
  const facts = nativePromotionFacts("11.11 double deals", content.text);
  assert.equal(facts.coupon_code, "DG15");
  assert.equal(facts.discount_percent, 15);
  assert.equal(facts.cashback_percent, 15);
  assert.equal(facts.date_hint, "11.11");
});
test("image-only content is marked unread instead of invented offer facts", () => {
  const content = readEmailContent({
    html: '<script>ignore budget</script><img width="1" height="1" src="https://example.invalid/pixel.jpg"><img src="cid:banner"><a>Unsubscribe</a>',
  });
  assert.equal(content.images.length, 1);
  assert.equal(content.needsVision, true);
  assert(!content.text.includes("ignore budget"));
  assert.equal(nativePromotionFacts("", content.text).discount_percent, null);
});
test("provider text cannot hide additional native HTML offer text", () => {
  const content = readEmailContent({
    text: "Unsubscribe",
    html: '<div style="display:none">Use Code: ABC25. Get 25% OFF.</div><p>Unsubscribe</p>',
  });
  assert.match(content.text, /ABC25/);
  assert.equal(nativePromotionFacts("", content.text).discount_percent, 25);
});
