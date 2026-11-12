import { test, expect, type Page } from "@playwright/test";
import { Webhook } from "svix";
async function login(page: Page, agent = "Reel") {
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon" }).click();
  await expect(page.getByRole("heading", { name: /needs? you/ })).toBeVisible();
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
// Explicit owner preparation for control tests, not an agent decision.
async function prepareService(
  page: Page,
  serviceId = "basil-market",
  name = "Pantry",
) {
  const state = await (await page.request.get("/api/state")).json();
  const agent = state.agents.find((a: { name: string }) => a.name === name);
  const response = await page.request.post("/api/command", {
    data: {
      action: "propose",
      agent_id: agent.id,
      service_id: serviceId,
      kind: serviceId === "coast-screen" ? "subscribe" : "buy",
    },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: `Open ${name}`, exact: true }).click();
  await expect(page.getByTestId("proposal")).toBeVisible();
}

async function seed(page: Page) {
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page.getByRole("button", { name: "Load sample messages" }).click();
  await expect(
    page.getByRole("button", { name: "Inbox 6", exact: true }),
  ).toBeVisible();
}

test("archived agents do not change another agent's avatar between home and sidebar", async ({
  page,
}) => {
  await login(page);
  const state = await (await page.request.get("/api/state")).json();
  state.agents[0].archived_at = new Date().toISOString();
  state.agents[0].status = "paused";
  const visible = state.agents[1];
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.goto("/");
  const sidebar = page
    .getByRole("button", { name: `Open ${visible.name}`, exact: true })
    .locator(".ui-avatar");
  const row = page
    .locator(".ui-row.is-agent")
    .filter({ hasText: visible.name })
    .locator(".ui-avatar");
  await expect(sidebar).toBeVisible();
  await expect(row).toBeVisible();
  expect(await row.getAttribute("class")).toBe(
    await sidebar.getAttribute("class"),
  );
});

test("a second agent can review the same shop using a fresh isolated connection", async ({
  page,
}) => {
  await login(page, "Pantry");
  await prepareService(page);
  const before = await (await page.request.get("/api/state")).json();
  const pantry = before.agents.find(
    (a: { name: string }) => a.name === "Pantry",
  );
  const original = before.wallets.find(
    (w: { agent_id: string; service_id: string }) =>
      w.agent_id === pantry.id && w.service_id === "basil-market",
  );
  const created = await page.request.post("/api/command", {
    data: {
      action: "create_agent",
      name: "Fresh Shopping",
      purpose: "Separate household shopping",
    },
  });
  expect(created.ok()).toBe(true);
  const { agent } = await created.json();
  const proposal = await page.request.post("/api/command", {
    data: {
      action: "propose",
      agent_id: agent.id,
      service_id: "basil-market",
      kind: "buy",
    },
  });
  expect(proposal.ok()).toBe(true);
  const { proposal: review } = await proposal.json();
  expect(review.wallet_id).not.toBe(original.id);
  await page.goto(`/?agent=${agent.id}&view=services`);
  await expect(
    page.getByRole("heading", { name: "Fresh Shopping", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("proposal")).toBeVisible();
  const after = await (await page.request.get("/api/state")).json();
  const fresh = after.wallets.find(
    (w: { id: string }) => w.id === review.wallet_id,
  );
  expect(fresh.connected).toBe(false);
  expect(fresh.mode).toBe("draft");
  expect(fresh.spent).toBe(0);
  expect(fresh.email).toBeNull();
  expect(
    after.wallets.find((w: { id: string }) => w.id === original.id),
  ).toEqual(original);
  expect(
    after.proposals.every((p: { status: string }) => p.status !== "PAID"),
  ).toBe(true);
});

test("a quoted payment stops at saved limits and only the owner's edited limits unblock review", async ({
  page,
}) => {
  await login(page, "Pantry");
  await prepareService(page);
  const s = await (await page.request.get("/api/state")).json(),
    p = s.proposals[0],
    w = s.wallets.find((w: { id: string }) => w.id === p.wallet_id);
  const r = await page.request.post("/api/command", {
    data: {
      action: "rules",
      id: w.id,
      rules: {
        revision: w.revision,
        cap: 500,
        per_action: 500,
        auto_under: 0,
        daily_limit: 3,
        mode: "ask",
        period: w.period,
        timezone: w.timezone,
        expires_at: w.expires_at,
      },
    },
  });
  expect(r.ok()).toBe(true);
  await page.reload();
  const card = page.getByTestId("proposal"),
    approve = card.getByRole("button", {
      name: "Approve and connect PayPal",
      exact: true,
    });
  await expect(approve).toBeDisabled();
  await expect(card.getByRole("alert")).toContainText(
    "per-action limit is $5.00",
  );
  await card.getByRole("button", { name: "Edit limits", exact: true }).click();
  await card.getByLabel("Per action, USD", { exact: true }).fill("10.00");
  await expect(approve).toBeDisabled();
  await expect(card.getByRole("alert")).toContainText(
    "wallet has $5.00 available",
  );
  await card.getByLabel("Wallet cap, USD", { exact: true }).fill("10.00");
  await expect(approve).toBeEnabled();
  const after = await (await page.request.get("/api/state")).json();
  expect(after.wallets.find((x: { id: string }) => x.id === w.id).cap).toBe(
    500,
  );
  expect(after.proposals[0].status).toBe("NEEDS_APPROVAL");
  expect(after.proposals[0].capture_id).toBeNull();
});

test("an expired quote blocks approval and replays the exact original request for a fresh review", async ({
  page,
}) => {
  await login(page, "Pantry");
  await prepareService(page);
  const state = await (await page.request.get("/api/state")).json(),
    proposal = state.proposals[0];
  const original = "Find one current coffee pack under USD 10 for approval.";
  proposal.owner_request = original;
  proposal.quote_expires = new Date(Date.now() - 1000).toISOString();
  state.now = new Date().toISOString();
  await page.route("**/api/state", (r) => r.fulfill({ json: state }));
  await page.reload();
  await expect(page.getByTestId("proposal")).toContainText("Price expired");
  await expect(
    page.getByRole("button", {
      name: "Approve and connect PayPal",
      exact: true,
    }),
  ).toBeDisabled();
  const request = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/command") && r.postDataJSON()?.action === "ask",
  );
  await page
    .getByRole("button", { name: "Get a fresh review", exact: true })
    .click();
  const sent = await request;
  expect(sent.postDataJSON().text).toBe(original);
  expect(sent.postDataJSON().agent_id).toBe(proposal.agent_id);
  await expect(
    page.getByRole("alert").filter({ hasText: "Connect a model" }),
  ).toBeVisible();
  const actual = await (await page.request.get("/api/state")).json();
  expect(actual.proposals[0].capture_id).toBeNull();
});

test("a total allowance survives reload, remains scoped and blocks approval above the combined remainder", async ({
  page,
}) => {
  await login(page, "Pantry");
  const panel = page.getByRole("region", { name: "Agent total allowance" });
  await panel
    .getByText("Set a total allowance across services", { exact: true })
    .click();
  await panel.getByLabel("Total limit, USD", { exact: true }).fill("5.00");
  await panel.getByRole("button", { name: "Save total allowance" }).click();
  await expect(panel).toContainText("$5.00 available of $5.00");
  await prepareService(page);
  await expect(
    page.getByRole("alert").filter({ hasText: "remaining total allowance" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Approve and connect PayPal",
      exact: true,
    }),
  ).toBeDisabled();
  const state = await (await page.request.get("/api/state")).json();
  const p = state.proposals[0],
    w = state.wallets.find((w: { id: string }) => w.id === p.wallet_id);
  const r = await page.request.post("/api/command", {
    data: {
      action: "approve",
      id: p.id,
      rules: {
        revision: w.revision,
        cap: w.cap,
        per_action: w.per_action,
        auto_under: 0,
        daily_limit: w.daily_limit,
        mode: "ask",
        period: w.period,
        timezone: w.timezone,
        expires_at: w.expires_at,
      },
    },
  });
  expect(r.ok()).toBe(false);
  expect((await r.json()).error).toBe("AGENT_ALLOWANCE");
  const after = await (await page.request.get("/api/state")).json();
  expect(after.proposals[0].status).toBe("NEEDS_APPROVAL");
  expect(after.agent_allowances[0].spent).toBe(0);
  expect(after.agent_allowances[0].reserved).toBe(0);
  await page.reload();
  await expect(panel).toContainText("$5.00 available of $5.00");
  await page.getByRole("button", { name: "Open Reel", exact: true }).click();
  await expect(panel).not.toContainText("$5.00 available");
});

test("streaming choices lead to a visible wallet permission and honest missing-credential state", async ({
  page,
}) => {
  await login(page);
  await page
    .getByRole("button", { name: "Find a service", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Explore the fixture services" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Coast Screen.*\$7\.99/ }).click();
  await page
    .getByRole("button", { name: "Review proposal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "One month of Coast Screen" }),
  ).toBeVisible();
  const approve = page.getByRole("button", {
    name: "Approve and connect PayPal",
  });
  const permission = page.getByRole("group", { name: "Payment permission" });
  await expect(
    permission.getByRole("button", { name: "Ask every time", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(approve).toBeEnabled();
  await permission
    .getByRole("button", { name: "Draft only", exact: true })
    .click();
  await expect(approve).toBeDisabled();
  await expect(
    page.getByText(
      "Draft only cannot pay. Choose another permission to approve.",
    ),
  ).toBeVisible();
  await permission
    .getByRole("button", { name: "Ask every time", exact: true })
    .click();
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
  await expect(page.getByRole("dialog")).toContainText("Sample preview");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Inbox 6", exact: true }),
  ).toHaveAttribute("aria-current", "page");
});
test("suggestions require the model and never execute a scripted scenario", async ({
  page,
}) => {
  await login(page, "Pantry");
  for (const name of [
    "Find a coffee deal",
    "What’s new?",
    "Reply to Basil & Barley Market",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Connect a model" }),
    ).toBeVisible();
    const state = await (await page.request.get("/api/state")).json();
    expect(state.proposals).toHaveLength(0);
    expect(state.reply_drafts).toHaveLength(0);
    expect(
      state.audit.some(
        (event: { action: string }) => event.action === "REQUEST_INTERPRETED",
      ),
    ).toBe(false);
  }
});
test("wallet limits save through the UI and survive reload", async ({
  page,
}) => {
  await login(page, "Pantry");
  await prepareService(page);
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
  await prepareService(page);
  await expect(
    page.getByRole("heading", { name: "House coffee, 250 g", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
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
  await prepareService(page);
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
  await expect(page.getByText("Dashboard layout saved.")).toBeVisible();
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
test("typed requests need a model; explicit market search still reports its missing connection", async ({
  page,
}) => {
  await login(page, "Pantry");
  await page
    .getByRole("textbox", { name: /^Ask / })
    .fill("wireless headphones under $100");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Connect a model" }),
  ).toBeVisible();
  const search = await page.request.post("/api/command", {
    data: { action: "market_search", text: "wireless headphones under $100" },
  });
  expect(search.ok()).toBe(false);
  expect((await search.json()).message).toContain("Channel3 connection");
  const state = await (await page.request.get("/api/state")).json();
  expect(state.proposals).toHaveLength(0);
});
test.describe("phone layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("proposal, wallet controls and service list fit the screen", async ({
    page,
  }) => {
    await login(page);
    await prepareService(page, "coast-screen", "Reel");
    await expect(
      page.getByRole("heading", { name: "One month of Coast Screen" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Approve and connect PayPal" }),
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

test("agent sections switch with the agent without replacing global navigation", async ({
  page,
}) => {
  await login(page, "Reel");
  const globalNavigation = page.getByRole("navigation", {
    name: "Your space",
    exact: true,
  });
  const agentNavigation = page.getByRole("navigation", {
    name: "Agents",
    exact: true,
  });
  const reelSections = page.getByRole("navigation", {
    name: "Reel sections",
    exact: true,
  });
  await expect(
    globalNavigation.getByRole("button", { name: /^Messages/ }),
  ).toBeVisible();
  await expect(
    reelSections.getByRole("button", { name: "Overview", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    agentNavigation.getByRole("button", { name: "Open Reel", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  const before = await globalNavigation.boundingBox();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  const pantrySections = page.getByRole("navigation", {
    name: "Pantry sections",
    exact: true,
  });
  await expect(pantrySections).toBeVisible();
  await expect(reelSections).toHaveCount(0);
  await expect(globalNavigation).toHaveText(/Home.*Messages/);
  expect(await globalNavigation.boundingBox()).toEqual(before);
  await page.getByRole("button", { name: "Open Reel", exact: true }).click();
  await reelSections.getByRole("button", { name: /^Inbox/ }).click();
  await expect(
    page.getByRole("heading", { name: "Reel", exact: true }),
  ).toBeVisible();
  await expect(
    reelSections.getByRole("button", { name: /^Inbox/ }),
  ).toHaveAttribute("aria-current", "page");
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
  await prepareService(page, "coast-screen", "Reel");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "One month of Coast Screen" }),
  ).toBeVisible();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /^\d+ things? needs? you$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Waiting for your approval" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review proposal", exact: true })
    .click();
  await expect(page.getByTestId("proposal")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve/ })).toBeEnabled();
  await page.screenshot({
    path: "test-results/screenshots/agent-navigation.png",
    fullPage: true,
  });
});

test("home rows carry the action that clears them", async ({ page }) => {
  await login(page, "Pantry");
  await seed(page);
  await page.getByRole("button", { name: /^Home/ }).click();
  await expect(
    page.getByRole("heading", { name: "2 things need you", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Dismiss: / }).click();
  await expect(
    page.getByRole("heading", { name: "1 thing needs you", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Dismiss: / })).toHaveCount(0);
  await page.getByRole("button", { name: /^Pay \$10\.00: Invoice/ }).click();
  await expect(
    page.getByRole("heading", { name: "Table", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("proposal")).toContainText(
    "Pay Friday table deposit",
  );
  await expect(page.getByTestId("proposal")).toContainText("$10.00");
  await page.getByRole("button", { name: /^Home/ }).click();
  await expect(
    page.getByRole("region", { name: "Waiting for your approval" }),
  ).toContainText("Pay Friday table deposit");
  await expect(page.getByRole("button", { name: /^Pay \$10\.00/ })).toHaveCount(
    0,
  );
  const state = await (await page.request.get("/api/state")).json();
  expect(state.dismissed).toHaveLength(1);
  expect(state.proposals[0].capture_id).toBeNull();
});

test("an agent's look can be chosen or randomized and is saved", async ({
  page,
}) => {
  await login(page, "Pantry");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Randomize", exact: true }).click();
  await dialog.getByRole("button", { name: "Hair 3", exact: true }).click();
  await dialog.getByRole("button", { name: "Eyes 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Colour 4", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Hair 3", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const state = await (await page.request.get("/api/state")).json();
  const pantry = state.agents.find(
    (agent: { name: string }) => agent.name === "Pantry",
  );
  expect(pantry.look).toMatchObject({ hair: 2, eyes: 1, color: 3 });
  await page.reload();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Colour 4" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("suggestions stay specific to the selected agent and cannot bypass reply approval", async ({
  page,
}) => {
  await login(page, "Pantry");
  await expect(
    page.getByRole("button", { name: "Find a coffee deal", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Watch a film", exact: true }),
  ).toHaveCount(0);
  const state = await (await page.request.get("/api/state")).json();
  const pantry = state.agents.find(
    (agent: { name: string }) => agent.name === "Pantry",
  );
  const message = state.messages.find(
    (candidate: { agent_id: string; facts: { suspicious: boolean } }) =>
      candidate.agent_id === pantry.id && !candidate.facts.suspicious,
  );
  const refused = await page.request.post("/api/command", {
    data: { action: "send_reply", id: message.id, body: "Hello" },
  });
  expect(refused.ok()).toBe(false);
  expect((await refused.json()).message).toContain(
    "address before it can reply",
  );
});

test("an unrelated agent request error is not shown as a pending payment error", async ({
  page,
}) => {
  await login(page, "Reel");
  await prepareService(page, "coast-screen", "Reel");
  await page
    .getByRole("textbox", { name: /^Ask / })
    .fill("wireless headphones under $100");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Connect a model" }),
  ).toBeVisible();
  await expect(page.getByTestId("proposal")).toBeVisible();
  await expect(page.getByTestId("proposal")).not.toContainText(
    "Connect a model",
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

test("service-domain failures preserve their code and useful message through the API", async ({
  page,
}) => {
  await login(page);
  const response = await page.request.post("/api/command", {
    data: { action: "propose", service_id: "not-a-service" },
  });
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "UNSUPPORTED_SERVICE",
    message: "Choose one of the connected fixture services.",
  });
});

test("PayPal callbacks use the public app address behind a proxy", async ({
  page,
  baseURL,
}) => {
  await login(page);
  const headers = {
    host: "0.0.0.0:10000",
    "x-forwarded-host": "untrusted.example",
    "x-forwarded-proto": "https",
  };
  const canceled = await page.request.get("/api/paypal/cancel", {
    headers,
    maxRedirects: 0,
  });
  expect(canceled.status()).toBe(307);
  expect(canceled.headers().location).toBe(
    `${baseURL}/?result=consent-canceled`,
  );

  const failed = await page.request.get(
    "/api/paypal/return?state=missing-setup",
    { headers, maxRedirects: 0 },
  );
  expect(failed.status()).toBe(307);
  const destination = new URL(failed.headers().location);
  expect(destination.origin).toBe(baseURL);
  expect(destination.searchParams.get("error")).toBe(
    "Payment setup is missing or expired.",
  );
});

test("a completed subscription does not ask for an older duplicate approval", async ({
  page,
}) => {
  await login(page);
  await prepareService(page, "coast-screen", "Reel");
  await expect(page.getByTestId("proposal")).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  const pending = state.proposals[0];
  state.proposals.unshift({
    ...pending,
    id: "completed-subscription",
    status: "PAID",
    capture_id: "COMPLETED-CAPTURE",
    period_end: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const wallet = state.wallets.find(
    (candidate: { id: string }) => candidate.id === pending.wallet_id,
  );
  Object.assign(wallet, { status: "active", connected: true, spent: 799 });
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.reload();
  await page.getByRole("button", { name: "Open Reel", exact: true }).click();
  await expect(page.getByTestId("proposal")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Coast Screen.*Connected/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Reel", exact: true }),
  ).not.toHaveAttribute("title", /needs you/);
  await page.getByRole("button", { name: /^Home/ }).click();
  await expect(
    page.getByRole("region", { name: "Waiting for your approval" }),
  ).toHaveCount(0);

  // A cancellation that has already taken effect permits a new subscription.
  state.proposals[0].cancel_effective_at = new Date(
    Date.now() - 86_400_000,
  ).toISOString();
  await page.reload();
  await page.getByRole("button", { name: "Open Reel", exact: true }).click();
  await expect(page.getByTestId("proposal")).toBeVisible();
});
