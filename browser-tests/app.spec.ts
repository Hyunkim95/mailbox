import { test, expect, type Page } from "@playwright/test";
import { Webhook } from "svix";
async function login(page: Page, agent = "Reel") {
  await page.goto("/");
  await page.getByLabel("Demo access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Mailbox" }).click();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.configuration.paypal).toBe(false);
  expect(state.configuration.email).toBe(false);
  expect(state.configuration.model).toBe(false);
  await page
    .getByRole("button", { name: `Open ${agent}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: agent, exact: true }),
  ).toBeVisible();
}
async function seed(page: Page) {
  await page.getByText("Demo setup", { exact: true }).click();
  await page.getByRole("button", { name: "Load preview emails" }).click();
  await expect(
    page.getByRole("button", { name: "Inbox 6", exact: true }),
  ).toBeVisible();
}

test("streaming choices lead to explicit wallet permission and honest missing-credential state", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Watch a film", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Three ways to watch The Lantern Coast",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Coast Screen \$7.99/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Review proposal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "One month of Coast Screen" }),
  ).toBeVisible();
  const approve = page.getByRole("button", {
    name: "Approve & connect PayPal",
  });
  await expect(approve).toBeDisabled();
  await page.getByLabel("Payment permission").selectOption("ask");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(
    page
      .getByText(
        "Add the PayPal and email credentials before approving a live sandbox action.",
      )
      .first(),
  ).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.proposals[0].capture_id).toBeNull();
  expect(state.wallets[0].spent).toBe(0);
  expect(state.wallets[0].reserved).toBe(0);
});
test("fixture mail, original source view and keyboard dismissal work without a chat panel", async ({
  page,
}) => {
  await login(page, "Pantry");
  await seed(page);
  await page.getByRole("button", { name: "Inbox 6", exact: true }).click();
  await page
    .getByRole("button", { name: /This week: house coffee, 250 g/ })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Fixture preview");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Service messages", exact: true }),
  ).toBeVisible();
});
test("coffee proposal explains unit comparison, stale rejection and source evidence", async ({
  page,
}) => {
  await login(page, "Pantry");
  await seed(page);
  await page
    .getByRole("button", { name: "Find a coffee deal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Why this deal", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".proposal-rationale")).toContainText(
    "excluded 1 expired email offer",
  );
  await expect(
    page.locator(".deal-comparison tbody tr").filter({ hasText: "250 g" }),
  ).toContainText(/\$6\.50.*\$26\.00/);
  await expect(
    page.locator(".deal-comparison tbody tr").filter({ hasText: "500 g" }),
  ).toContainText(/\$14\.75.*\$29\.50/);
  await page
    .locator(".source-links")
    .getByRole("button", { name: /This week: house coffee/ })
    .click();
  await expect(page.getByRole("dialog")).toContainText("coffee-250g");
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: "test-results/screenshots/coffee-desktop.png",
    fullPage: true,
  });
});
test("wallet limits save through the UI and survive reload", async ({
  page,
}) => {
  await login(page, "Pantry");
  await page
    .getByRole("button", { name: "Find a coffee deal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "House coffee, 250 g", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Basil & Barley Market Ready to connect/ })
    .click();
  await page.getByRole("button", { name: "Wallet rules", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Wallet cap, USD").fill("100");
  await dialog.getByLabel("Per action, USD").fill("100");
  await dialog.getByLabel("Daily action limit").fill("2");
  await dialog.getByLabel("Budget resets").selectOption("month");
  await dialog.getByLabel("Budget timezone").fill("UTC");
  await dialog
    .getByRole("button", { name: "Save wallet rules", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.wallets[0].cap).toBe(10000);
  expect(state.wallets[0].daily_limit).toBe(2);
  expect(state.wallets[0].period).toBe("month");
  expect(state.wallets[0].timezone).toBe("UTC");
});
test("reset creates a fresh workspace and cancels queued authority", async ({
  page,
}) => {
  await login(page, "Pantry");
  await page
    .getByRole("button", { name: "Find a coffee deal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "House coffee, 250 g", exact: true }),
  ).toBeVisible();
  await page.getByText("Demo setup", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Reset workspace", exact: true })
    .click();
  await expect(
    page.getByText(
      "Fresh workspace opened. Old wallets are paused and past sandbox payments remain recorded.",
    ),
  ).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.wallets).toHaveLength(0);
  expect(state.proposals).toHaveLength(0);
});
test("disconnect blocks spending and reconnect requires fresh permission", async ({
  page,
}) => {
  await login(page, "Pantry");
  await page
    .getByRole("button", { name: "Find a coffee deal", exact: true })
    .click();
  await page
    .getByRole("button", { name: /Basil & Barley Market Ready to connect/ })
    .click();
  await page.getByRole("button", { name: "Wallet rules", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Disconnect PayPal permission", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let state = await (await page.request.get("/api/state")).json();
  expect(state.wallets[0].status).toBe("revoked");
  expect(state.wallets[0].connected).toBe(false);
  expect(state.proposals[0].status).toBe("BLOCKED");
  await page.getByRole("button", { name: "Wallet rules", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Payment permission is disconnected.",
  );
  await page
    .getByRole("button", { name: "Start a fresh connection", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  state = await (await page.request.get("/api/state")).json();
  expect(state.wallets[0].status).toBe("draft");
  expect(state.wallets[0].mode).toBe("draft");
  expect(state.wallets[0].connected).toBe(false);
  expect(state.proposals[0].capture_id).toBeNull();
});
test("HTML newsletter shows its source and separate discount and cashback facts", async ({
  page,
}) => {
  await login(page, "Pantry");
  await seed(page);
  await page.getByRole("button", { name: "Inbox 6", exact: true }).click();
  await page.getByRole("button", { name: /11.11 pantry picks/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("15% immediate discount");
  await expect(dialog).toContainText("15% advertised cashback");
  await expect(dialog).toContainText("PANTRY15");
  await expect(dialog.getByTitle("Original email preview")).toHaveAttribute(
    "sandbox",
    "",
  );
  await expect(
    page
      .frameLocator('iframe[title="Original email preview"]')
      .getByRole("heading", { name: "Your pantry, happily stocked." }),
  ).toBeVisible();
});
test("AG Studio layout saves for its niche and stays private to its workspace", async ({
  page,
  browser,
}) => {
  await login(page, "Pantry");
  await seed(page);
  await page
    .getByRole("navigation", { name: "Pantry sections" })
    .getByRole("button", { name: "Dashboard", exact: true })
    .click();
  await expect(page.getByTestId("niche-studio")).toBeVisible();
  await page
    .getByRole("button", { name: "Restore default", exact: true })
    .click();
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(
    page.getByText("Dashboard layout saved for this niche."),
  ).toBeVisible();
  const ownerState = await (await page.request.get("/api/state")).json();
  const agentId = ownerState.agents.find(
    (agent: { name: string }) => agent.name === "Pantry",
  ).id;
  const saved = await (
    await page.request.get(`/api/studio?agent_id=${agentId}`)
  ).json();
  expect(saved.layout.pages[0].widgets).toBeTruthy();
  expect(Object.keys(saved.layout.pages[0].widgets)).toHaveLength(2);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await login(other, "Pantry");
    const otherState = await (await other.request.get("/api/state")).json();
    const otherAgentId = otherState.agents.find(
      (agent: { name: string }) => agent.name === "Pantry",
    ).id;
    const isolated = await (
      await other.request.get(`/api/studio?agent_id=${otherAgentId}`)
    ).json();
    expect(isolated.layout).toBeNull();
    expect(
      (await other.request.get(`/api/studio?agent_id=${agentId}`)).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
});
test("market search reports missing Channel3 access without a fabricated product or purchase", async ({
  page,
}) => {
  await login(page, "Pantry");
  await page
    .getByRole("button", { name: "Across the market", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^Ask / })
    .fill("wireless headphones under $100");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Channel3 connection" }),
  ).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.proposals).toHaveLength(0);
});
test.describe("phone layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("proposal, wallet controls and service list fit the screen", async ({
    page,
  }) => {
    await login(page);
    await page
      .getByRole("button", { name: "Watch a film", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review proposal", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "One month of Coast Screen" }),
    ).toBeVisible();
    await page.getByLabel("Payment permission").selectOption("ask");
    await expect(
      page.getByRole("button", { name: "Approve & connect PayPal" }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: "test-results/screenshots/streaming-phone.png",
      fullPage: true,
    });
  });
});

test("agent sections stay nested without replacing global navigation", async ({
  page,
}) => {
  await login(page, "Reel");
  const globalNavigation = page.getByRole("navigation", {
    name: "Your space",
    exact: true,
  });
  const reelSections = page.getByRole("navigation", {
    name: "Reel sections",
    exact: true,
  });
  await expect(
    globalNavigation.getByRole("button", { name: /All messages/ }),
  ).toBeVisible();
  await expect(
    reelSections.getByRole("button", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const before = await globalNavigation.boundingBox();
  await page
    .getByRole("button", { name: "Open Pantry workspace", exact: true })
    .click();
  const pantrySections = page.getByRole("navigation", {
    name: "Pantry sections",
    exact: true,
  });
  await expect(reelSections).toBeVisible();
  await expect(pantrySections).toBeVisible();
  await expect(globalNavigation).toHaveText(
    /Your agentsAll messages.*Before Mailbox/,
  );
  expect(await globalNavigation.boundingBox()).toEqual(before);
  await reelSections.getByRole("button", { name: /^Inbox/ }).click();
  await expect(
    page.getByRole("heading", { name: "Reel", exact: true }),
  ).toBeVisible();
  await expect(
    reelSections.getByRole("button", { name: /^Inbox/ }),
  ).toHaveAttribute("aria-current", "page");
  await expect(pantrySections).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Reel", exact: true }),
  ).toBeVisible();
  await expect(
    reelSections.getByRole("button", { name: /^Inbox/ }),
  ).toHaveAttribute("aria-current", "page");
  await reelSections
    .getByRole("button", { name: "Overview", exact: true })
    .click();
  await page.getByRole("button", { name: "Watch a film", exact: true }).click();
  await page
    .getByRole("button", { name: "Review proposal", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "One month of Coast Screen" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/screenshots/nested-agent-navigation.png",
    fullPage: true,
  });
});

test("an unrelated search error is not shown as a pending payment error", async ({
  page,
}) => {
  await login(page, "Reel");
  await page.getByRole("button", { name: "Watch a film", exact: true }).click();
  await page
    .getByRole("button", { name: "Review proposal", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Across the market", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^Ask / })
    .fill("wireless headphones under $100");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Channel3 connection" }),
  ).toBeVisible();
  await expect(page.locator(".proposal-card")).toBeVisible();
  await expect(page.locator(".proposal-card")).not.toContainText(
    "Channel3 connection",
  );
});

test("AgentMail verifies the raw signature before parsing a signed event", async ({
  request,
}) => {
  const verifier = new Webhook(
    `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
  );
  const id = "msg_browser_webhook";
  const now = new Date();
  const raw = JSON.stringify({ event_type: "message.received" });
  const signedHeaders = (text: string) => ({
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
    "svix-signature": verifier.sign(id, now, text),
  });
  const valid = await request.post("/api/webhooks/agentmail", {
    headers: signedHeaders(raw),
    data: raw,
  });
  expect(valid.status()).toBe(200);
  expect(await valid.json()).toEqual({ accepted: true });
  const tampered = await request.post("/api/webhooks/agentmail", {
    headers: signedHeaders(raw),
    data: raw + " ",
  });
  expect(tampered.status()).toBe(401);
  const invalid = await request.post("/api/webhooks/agentmail", {
    headers: signedHeaders("null"),
    data: "null",
  });
  expect(invalid.status()).toBe(400);
});
