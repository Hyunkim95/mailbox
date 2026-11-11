import { test, expect, type Page } from "@playwright/test";
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Demo access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Mailbox" }).click();
  await expect(
    page.getByRole("heading", { name: "What would you like to do?" }),
  ).toBeVisible();
  const state = await (await page.request.get("/api/state")).json();
  expect(state.configuration.paypal).toBe(false);
  expect(state.configuration.email).toBe(false);
  expect(state.configuration.model).toBe(false);
}
async function seed(page: Page) {
  await page.getByText("Demo setup", { exact: true }).click();
  await page.getByRole("button", { name: "Load preview emails" }).click();
  await expect(
    page.getByRole("button", { name: "Service messages 24", exact: true }),
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
  await login(page);
  await seed(page);
  await page
    .getByRole("button", { name: "Service messages 24", exact: true })
    .click();
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
  await login(page);
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
  await login(page);
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
  await login(page);
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
  await login(page);
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
