import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";

// This server simulates native model tool choices, not Mailbox API responses.
// The browser still exercises the real API, executor, inbox and source controls.
let provider: Server;
const choices: string[] = [];
const monthlyDate = new Date(Date.now() + 4 * 86400_000)
  .toISOString()
  .slice(0, 10);
const monthlyStart = `${monthlyDate}T09:00:00Z`;
const monthlyEnd = new Date(
  new Date(monthlyStart).getTime() + 95 * 86400_000,
).toISOString();
test.beforeAll(async () => {
  provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const outputs = body.input.filter(
      (entry: { type: string }) => entry.type === "function_call_output",
    );
    const context = JSON.parse(body.input[0].content);
    let name: string, args: unknown;
    if (context.request.includes("monthly rule")) {
      const result = (i: number) => JSON.parse(outputs[i].output);
      const next = [
        () => ({ name: "list_purchase_rules", args: {} }),
        () => ({ name: "list_services", args: { query: "pets" } }),
        () => ({
          name: "get_quote",
          args: {
            service_id: result(1).services[0].id,
            item_id: result(1).services[0].items[0].id,
            quantity: 1,
            booking: null,
          },
        }),
        () => ({
          name: "prepare_purchase_schedule",
          args: {
            quote_id: result(2).id,
            rule: {
              timezone: "UTC",
              day_of_month: Number(monthlyDate.slice(-2)),
              local_time: "09:00",
              starts_at: monthlyStart,
              expires_at: monthlyEnd,
              max_amount_minor: 3000,
              price_inclusive: false,
            },
            rationale:
              "This exact item and quantity are prepared as the owner's requested monthly rule, below USD 30 delivered. The owner still needs to approve the standing permission.",
            sources: [],
          },
        }),
        () => ({
          name: "finish",
          args: {
            answer:
              "Monthly rule prepared for approval. It is not active and no payment was made.",
            sources: [],
          },
        }),
      ];
      ({ name, args } = next[outputs.length]!());
    } else if (context.request.includes("Compare pack sizes")) {
      const result = (i: number) => JSON.parse(outputs[i].output);
      const next = [
        () => ({ name: "search_messages", args: { query: "Last week" } }),
        () => ({
          name: "read_message",
          args: { message_id: result(0).messages[0].id },
        }),
        () => ({ name: "list_services", args: { query: "groceries" } }),
        () => ({
          name: "get_quote",
          args: {
            service_id: result(2).services[0].id,
            item_id: result(2).services[0].items[0].id,
            quantity: 1,
            booking: null,
          },
        }),
        () => ({
          name: "get_quote",
          args: {
            service_id: result(2).services[0].id,
            item_id: result(2).services[0].items[1].id,
            quantity: 1,
            booking: null,
          },
        }),
        () => ({
          name: "compare_quotes",
          args: {
            quote_ids: [result(3).id, result(4).id],
            offer_source_ids: [result(1).id],
            max_amount_minor: 1000,
          },
        }),
        () => {
          const selected = result(5).comparison.rows.find(
            (r: { eligible: boolean }) => r.eligible,
          );
          const quote = [result(3), result(4)].find(
            (q) => q.item_id === selected.item_id,
          );
          return {
            name: "prepare_proposal",
            args: {
              quote_id: quote.id,
              rationale:
                "This current quote has the lowest delivered unit price within the requested limit; the original expired offer is not a current price.",
              sources: [result(1).id],
              condition_under_minor: null,
            },
          };
        },
        () => ({
          name: "finish",
          args: {
            answer:
              "A current purchase is prepared for review. No payment was attempted.",
            sources: [result(1).id],
          },
        }),
      ];
      ({ name, args } = next[outputs.length]!());
    } else if (context.request.includes("supporting files")) {
      const result = (i: number) => JSON.parse(outputs[i].output);
      if (outputs.length === 0) {
        name = "search_messages";
        args = { query: "" };
      } else if (outputs.length === 1) {
        name = "read_message";
        args = { message_id: result(0).messages[0].id };
      } else if (outputs.length === 2) {
        name = "search_documents";
        args = { query: "" };
      } else if (outputs.length === 3) {
        name = "read_document";
        args = { document_id: result(2).documents[0].id, offset: 0 };
      } else if (outputs.length === 4) {
        name = "record_task";
        args = {
          task_id: null,
          text: "Review the supporting document",
          status: "ready",
          note: "Document evidence gathered for review.",
          sources: [result(1).id, result(3).id],
        };
      } else if (outputs.length === 5) {
        name = "prepare_reply";
        args = {
          message_id: result(1).id,
          body: "The supporting document confirms invoice REF-204, USD 24.00. Please review the prepared attachment.",
          sources: [result(1).id, result(3).id],
          document_ids: [result(3).id],
        };
      } else {
        name = "finish";
        args = {
          answer: "Supporting evidence and a reply are ready for review.",
          sources: [result(1).id, result(3).id],
        };
      }
    } else if (!outputs.length) {
      name = "search_messages";
      args = { query: "" };
    } else if (outputs.length === 1) {
      name = "read_message";
      args = { message_id: JSON.parse(outputs[0].output).messages[0].id };
    } else {
      const message = JSON.parse(outputs[1].output);
      name = "finish";
      args = {
        answer: `I checked the source email: ${message.subject}. Its origin is ${message.origin}.`,
        sources: [message.id],
      };
    }
    choices.push(name);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `resp_${choices.length}`,
        object: "response",
        model: body.model,
        status: "completed",
        output: [
          {
            id: `fc_${choices.length}`,
            type: "function_call",
            call_id: `call_${choices.length}`,
            name,
            arguments: JSON.stringify(args),
            status: "completed",
          },
        ],
      }),
    );
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
test.beforeEach(() => {
  choices.length = 0;
});

test("typed requests use sequential capabilities and expose the actual cited source", async ({
  page,
}) => {
  let unwantedSearches = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/api/command") &&
      request.postDataJSON()?.action === "market_search"
    )
      unwantedSearches++;
  });
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon" }).click();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ask Pantry", exact: true })
    .fill("Read the latest message and tell me what the source actually says");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const answer = page.getByRole("region", { name: "Answer", exact: true });
  await expect(answer).toContainText("I checked the source email:");
  await expect(answer).toContainText("fixture_preview");
  expect(choices).toEqual(["search_messages", "read_message", "finish"]);
  expect(unwantedSearches).toBe(0);
  await answer.getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("Sample preview");
  await page.keyboard.press("Escape");
  const state = await (await page.request.get("/api/state")).json();
  expect(state.proposals).toHaveLength(0);
  expect(
    state.audit.filter(
      (event: { action: string }) => event.action === "AGENT_TOOL_COMPLETED",
    ),
  ).toHaveLength(2);
  await page.screenshot({
    path: "artifacts/qa/generic-agent-answer.png",
    fullPage: true,
  });
});

test("uploaded documents are searched, cited and prepared as attachments; work survives reopening and stays scoped", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon" }).click();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByLabel("Choose a document").setInputFiles({
    name: "Evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Invoice REF-204. Total USD 24.00. Paid."),
  });
  await expect(
    page.getByRole("button", { name: /Evidence.txt/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ask Pantry", exact: true })
    .fill("Gather the supporting files and prepare a reply for review");
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const reply = page.getByRole("region", { name: "Reply draft" });
  await expect(
    reply.getByRole("checkbox", { name: "Evidence.txt" }),
  ).toBeChecked();
  await expect(page.getByRole("region", { name: "Checklist" })).toContainText(
    "Review the supporting document",
  );
  await page.reload();
  await expect(
    reply.getByRole("checkbox", { name: "Evidence.txt" }),
  ).toBeChecked();
  await expect(reply.getByRole("textbox")).toHaveValue(/REF-204/);
  await reply
    .getByRole("button", { name: "Evidence.txt", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Invoice REF-204");
  await page.keyboard.press("Escape");
  const state = await (await page.request.get("/api/state")).json(),
    doc = state.documents[0];
  const original = await page.request.get(
    `/api/documents/${encodeURIComponent(doc.id)}/download`,
  );
  expect((await original.body()).toString()).toContain("REF-204");
  const stranger = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const other = await stranger.newPage();
    await other.goto("/");
    await other.getByLabel("Access key").fill("mailbox-browser-test-access");
    await other.getByRole("button", { name: "Open Pigeon" }).click();
    await expect(
      other.getByRole("heading", { name: /needs? you/ }),
    ).toBeVisible();
    expect(
      (
        await other.request.get(`/api/documents/${encodeURIComponent(doc.id)}`)
      ).status(),
    ).toBe(404);
  } finally {
    await stranger.close();
  }
  await page.getByRole("button", { name: "Open Reel", exact: true }).click();
  await expect(reply).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Checklist" })).toHaveCount(0);
  expect(choices).toEqual([
    "search_messages",
    "read_message",
    "search_documents",
    "read_document",
    "record_task",
    "prepare_reply",
    "finish",
  ]);
});

test("observed quote comparisons reach the review UI with expiry, affordability and original sources", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon" }).click();
  await page.getByRole("button", { name: "Open Pantry", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ask Pantry", exact: true })
    .fill(
      "Compare pack sizes for one purchase under USD 10 and prepare it for review",
    );
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const table = page.getByTestId("deal-comparison");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(
    table.locator("tbody tr").filter({ hasText: "250 g" }),
  ).toContainText(/\$6\.50.*\$26\.00/);
  await expect(
    table.locator("tbody tr").filter({ hasText: "500 g" }),
  ).toContainText("Above limit");
  const state = await (await page.request.get("/api/state")).json();
  expect(state.proposals[0].comparison.expired_offers).toBe(1);
  expect(state.proposals[0].status).toBe("NEEDS_APPROVAL");
  expect(state.proposals[0].capture_id).toBeNull();
  await page.getByTestId("source-links").getByRole("button").click();
  await expect(page.getByRole("dialog")).toContainText("expired");
  expect(choices).toContain("compare_quotes");
});

test("monthly purchase review requires explicit automatic authority and survives reopening without spending", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Access key").fill("mailbox-browser-test-access");
  await page.getByRole("button", { name: "Open Pigeon" }).click();
  await page.getByRole("button", { name: "Open Paws", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ask Paws", exact: true })
    .fill(
      `Prepare a monthly rule for one exact 3 kg adult-food item, below USD 30 delivered. At 09:00 UTC on day ${monthlyDate.slice(-2)}, from ${monthlyStart} until ${monthlyEnd}.`,
    );
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  const rule = page.getByLabel("Monthly purchase rule", { exact: true });
  await expect(rule).toContainText("1 × Adult dog food, 3 kg");
  await expect(rule).toContainText("Below $30.00 delivered");
  await expect(rule).toContainText("Next eligible purchase:");
  const approve = page.getByRole("button", {
    name: "Approve monthly rule and connect PayPal",
    exact: true,
  });
  await expect(approve).toBeDisabled();
  const permission = page.getByRole("group", { name: "Payment permission" });
  await permission
    .getByRole("button", { name: "Automatic within limits", exact: true })
    .click();
  await page.getByLabel("Automatic up to, USD").fill("30.00");
  await expect(approve).toBeEnabled();
  await permission
    .getByRole("button", { name: "Ask every time", exact: true })
    .click();
  await expect(approve).toBeDisabled();
  await permission
    .getByRole("button", { name: "Automatic within limits", exact: true })
    .click();
  await approve.click();
  await expect(page.getByTestId("proposal")).toContainText(
    "Add the PayPal and email credentials",
  );
  const state = await (await page.request.get("/api/state")).json(),
    p = state.proposals[0];
  expect(p.kind).toBe("schedule");
  expect(p.status).toBe("NEEDS_APPROVAL");
  expect(p.monthly_schedule.approved_at).toBeNull();
  expect(p.capture_id).toBeNull();
  expect(
    state.proposals.filter((c: { scheduled_by?: unknown }) => c.scheduled_by),
  ).toHaveLength(0);
  await page.reload();
  await expect(rule).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "artifacts/qa/monthly-rule-phone.png",
    fullPage: true,
  });
  expect(choices).toEqual([
    "list_purchase_rules",
    "list_services",
    "get_quote",
    "prepare_purchase_schedule",
    "finish",
  ]);
});
