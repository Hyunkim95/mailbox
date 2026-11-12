import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

// Only the model transport is simulated. Studio executes its actual tools, and
// the browser uses the real authenticated dashboard APIs and saved layouts.
let provider: Server;
const calls: string[] = [];
test.beforeAll(async () => {
  provider = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const prompt = body.input
        .filter((item: { role?: string }) => item.role === "user")
        .map((item: { content: unknown }) => JSON.stringify(item.content))
        .join(" ");
      if (prompt.includes("Report a test failure")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Dashboard provider temporarily unavailable" },
          }),
        );
        return;
      }
      if (prompt.includes("Wait for test cancellation")) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const outputs = body.input.filter(
        (item: { type: string }) => item.type === "function_call_output",
      );
      const names = body.tools.map((tool: { name: string }) => tool.name);
      if (new Set(names).size !== names.length)
        throw Error("Duplicate dashboard tool names");
      for (const output of outputs) {
        const result = JSON.parse(output.output);
        if (result.success === false)
          throw Error(`Dashboard tool failed: ${output.output}`);
      }
      const steps = [
        { name: "view_schema", args: {} },
        { name: "view_page", args: {} },
        {
          name: "add_widget",
          args: {
            widgetId: "message-review",
            type: "grid",
            xTrack: 0,
            yTrack: 30,
            xSpan: 24,
            ySpan: 16,
          },
        },
        {
          name: "configure_grid",
          args: {
            widgetId: "message-review",
            op: "patch",
            value: {
              dataMapping: {
                cols: [{ id: "messages.subject" }, { id: "messages.origin" }],
              },
              format: { title: { enabled: true, text: "Message review" } },
            },
          },
        },
      ];
      const step = steps[outputs.length];
      if (step) {
        const tool = body.tools.find(
          (tool: { name: string }) => tool.name === step.name,
        );
        if (!tool)
          throw Error(
            `Missing ${step.name}: ${body.tools.map((t: { name: string }) => t.name)}`,
          );
        calls.push(step.name);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `resp_${outputs.length}`,
          object: "response",
          status: "completed",
          output: step
            ? [
                {
                  id: `fc_${outputs.length}`,
                  type: "function_call",
                  call_id: `call_${outputs.length}`,
                  name: step.name,
                  arguments: JSON.stringify(step.args),
                  status: "completed",
                },
              ]
            : [
                {
                  id: "done",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "Added the message review grid. Save to keep it.",
                      annotations: [],
                    },
                  ],
                },
              ],
        }),
      );
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  provider.listen(
    Number(process.env.MAILBOX_BROWSER_PORT ?? 3400) + 12,
    "127.0.0.1",
  );
  await once(provider, "listening");
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    provider.close((error) => (error ? reject(error) : resolve())),
  );
});

test("unlicensed hosted settings allow customization, manual editing, scoped save and reload", async ({
  page,
}, testInfo) => {
  calls.length = 0;
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon", exact: true }).click();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  await page
    .getByRole("button", { name: "Workspace menu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Load sample messages", exact: true })
    .click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByTestId("niche-studio")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "interactive chart", exact: true }),
  ).toBeVisible();
  const before = await (await page.request.get("/api/state")).json();
  const pantry = before.agents.find(
    (agent: { name: string }) => agent.name === "Pantry",
  );
  const layout = () =>
    page.request.get(`/api/studio?agent_id=${pantry.id}`).then((r) => r.json());
  expect((await layout()).layout).toBeNull();
  await page
    .getByLabel("Customize this dashboard", { exact: true })
    .fill("Add a Message review grid showing message subjects and origins.");
  await page
    .getByRole("button", { name: "Customize dashboard", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Added the message review grid.",
  );
  await expect(page.getByText("Message review", { exact: true })).toBeVisible();
  expect(calls).toEqual([
    "view_schema",
    "view_page",
    "add_widget",
    "configure_grid",
  ]);
  expect((await layout()).layout).toBeNull();
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Dashboard layout saved",
  );
  expect((await layout()).layout.pages[0].widgets["message-review"].type).toBe(
    "grid",
  );
  await page.reload();
  await expect(
    page.getByRole("img", { name: "interactive chart", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Message review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit layout", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Preview layout", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Preview layout", exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("dashboard-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Message review", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const agents = page.getByRole("navigation", { name: "Agents", exact: true });
  const pantryLink = agents.getByRole("button", {
    name: "Open Pantry",
    exact: true,
  });
  const reelLink = agents.getByRole("button", {
    name: "Open Reel",
    exact: true,
  });
  expect((await pantryLink.boundingBox())!.y).toBe(
    (await reelLink.boundingBox())!.y,
  );
  await page.screenshot({
    path: testInfo.outputPath("dashboard-phone.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Open Reel", exact: true }).click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByTestId("niche-studio")).toBeVisible();
  await expect(page.getByText("Message review", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("Message review", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Restore default", exact: true })
    .click();
  await page.getByRole("button", { name: "Save layout", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Dashboard layout saved",
  );
  await page.reload();
  await expect(page.getByText("Message review", { exact: true })).toHaveCount(
    0,
  );
  const after = await (await page.request.get("/api/state")).json();
  expect(after.wallets).toEqual(before.wallets);
  expect(after.proposals).toEqual(before.proposals);
  expect(after.messages).toEqual(before.messages);
});

test("provider failures preserve the prompt and cancellation never reports success", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon", exact: true }).click();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  const input = page.getByLabel("Customize this dashboard", { exact: true });
  const submit = page.getByRole("button", {
    name: "Customize dashboard",
    exact: true,
  });
  await input.fill("Report a test failure");
  await submit.click();
  await expect(page.locator("main [role=alert]")).toBeVisible();
  await expect(input).toHaveValue("Report a test failure");
  await expect(submit).toBeEnabled();
  await input.fill("Wait for test cancellation");
  await submit.click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Update stopped. Review any changes before saving.",
  );
  await expect(submit).toBeEnabled();
  await expect(
    page.getByText("Dashboard updated. Review the layout before saving.", {
      exact: true,
    }),
  ).toHaveCount(0);
});
