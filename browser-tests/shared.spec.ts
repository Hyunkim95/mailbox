import { test, expect, type Page } from "@playwright/test";
const key = "mailbox-browser-test-access";
async function enter(page: Page) {
  await page.goto("/");
  await page.getByLabel("Demo access key").fill(key);
  await page.getByRole("button", { name: "Open Mailbox" }).click();
  await expect(
    page.getByRole("heading", { name: "Your agents." }),
  ).toBeVisible();
  await expect(
    page.getByText("Shared demo workspace", { exact: true }),
  ).toBeVisible();
}

test("the dedicated demo key reopens the same agents across sign-out and browsers", async ({
  page,
  browser,
}) => {
  await enter(page);
  const original = await (await page.request.get("/api/state")).json();
  expect(original.shared_demo).toBe(true);
  const reel = original.agents.find(
    (agent: { template: string }) => agent.template === "entertainment",
  );
  const edited = await page.request.post("/api/command", {
    data: { action: "update_agent", agent_id: reel.id, name: "Reel Reviews" },
  });
  expect(edited.ok()).toBe(true);
  await page.getByTitle("Sign out", { exact: true }).click();
  await expect(page.getByLabel("Demo access key")).toBeVisible();
  expect((await page.request.get("/api/state")).status()).toBe(401);
  await enter(page);
  const reopened = await (await page.request.get("/api/state")).json();
  expect(reopened.agents.map((agent: { id: string }) => agent.id)).toEqual(
    original.agents.map((agent: { id: string }) => agent.id),
  );
  expect(
    reopened.agents.find((agent: { id: string }) => agent.id === reel.id).name,
  ).toBe("Reel Reviews");
  const otherContext = await browser.newContext({
    baseURL: "http://127.0.0.1:3401",
  });
  try {
    const other = await otherContext.newPage();
    await other.goto("/");
    await other.getByLabel("Demo access key").fill("incorrect-access-key");
    await other.getByRole("button", { name: "Open Mailbox" }).click();
    await expect(
      other.getByRole("alert").filter({ hasText: "not accepted" }),
    ).toBeVisible();
    expect((await other.request.get("/api/state")).status()).toBe(401);
    await enter(other);
    const shared = await (await other.request.get("/api/state")).json();
    expect(shared.agents.map((agent: { id: string }) => agent.id)).toEqual(
      reopened.agents.map((agent: { id: string }) => agent.id),
    );
    expect(
      shared.agents.find((agent: { id: string }) => agent.id === reel.id).name,
    ).toBe("Reel Reviews");
    await page.screenshot({
      path: "artifacts/qa/shared-demo-login.png",
      fullPage: true,
    });
  } finally {
    await page.request.post("/api/command", {
      data: { action: "update_agent", agent_id: reel.id, name: reel.name },
    });
    await otherContext.close();
  }
});

test("shared demo reset keeps agent identities and history while blocking pending spending", async ({
  page,
}) => {
  await enter(page);
  const original = await (await page.request.get("/api/state")).json();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
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
      "Demo reset. Spending is paused; agent addresses, messages and payment history are kept.",
      { exact: true },
    ),
  ).toBeVisible();
  const reset = await (await page.request.get("/api/state")).json();
  expect(reset.agents.map((agent: { id: string }) => agent.id)).toEqual(
    original.agents.map((agent: { id: string }) => agent.id),
  );
  expect(reset.messages).toHaveLength(24);
  expect(
    reset.wallets.every((wallet: { paused: boolean }) => wallet.paused),
  ).toBe(true);
  expect(
    reset.proposals.every(
      (proposal: { status: string }) => proposal.status === "BLOCKED",
    ),
  ).toBe(true);
  await page.getByTitle("Sign out", { exact: true }).click();
  await enter(page);
  const reopened = await (await page.request.get("/api/state")).json();
  expect(reopened.agents.map((agent: { id: string }) => agent.id)).toEqual(
    reset.agents.map((agent: { id: string }) => agent.id),
  );
  expect(reopened.proposals).toEqual(reset.proposals);
});
