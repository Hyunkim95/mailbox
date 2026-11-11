import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { Webhook } from "svix";
import { z } from "zod";
import { MerchantError } from "@mailbox/service-sdk";
import { appService } from "../../../src/runtime";
import {
  createSession,
  ownerFromSession,
  validAccessKey,
  cookieOptions,
} from "../../../src/auth";
import {
  syncInbox,
  provisionAgentAddress,
  syncAgentInbox,
} from "../../../src/email";
import { seedMessages } from "../../../src/seed";
import { searchMarket } from "../../../src/market";
import { studioTurn } from "../../../src/studio-model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ route: string[] }> };
const ruleSchema = z.object({
  revision: z.number().int(),
  cap: z.number().int(),
  per_action: z.number().int(),
  auto_under: z.number().int(),
  daily_limit: z.number().int(),
  mode: z.enum(["draft", "ask", "auto"]),
  paused: z.boolean().optional(),
  period: z.enum(["week", "month"]).optional(),
  timezone: z.string().max(80).optional(),
  expires_at: z.string().max(64).optional(),
});
const commandSchema = z.object({
  action: z.enum([
    "ask",
    "market_search",
    "create_agent",
    "connect_agent",
    "update_agent",
    "studio_turn",
    "studio_save",
    "propose",
    "approve",
    "decline",
    "rules",
    "pause",
    "revoke",
    "reconnect",
    "cancel",
    "sync",
    "seed_preview",
    "seed_live",
    "reset",
    "login",
    "logout",
  ]),
  text: z.string().max(1500).optional(),
  example: z.string().optional(),
  id: z.string().optional(),
  service_id: z.string().optional(),
  kind: z.enum(["subscribe", "buy", "book", "condition"]).optional(),
  paused: z.boolean().optional(),
  rules: ruleSchema.optional(),
  key: z.string().max(300).optional(),
  agent_id: z.string().uuid().optional(),
  request_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60).optional(),
  purpose: z.string().trim().min(1).max(1500).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  niche: z
    .enum(["all", "entertainment", "groceries", "dining", "pets"])
    .optional(),
  turn: z.unknown().optional(),
  layout: z
    .object({
      pages: z
        .array(z.object({ id: z.string().max(100) }).passthrough())
        .min(1)
        .max(8),
      selectedPageId: z.string().max(100),
    })
    .passthrough()
    .optional(),
});
function response(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function failure(error: unknown) {
  if (error instanceof z.ZodError)
    return response(
      {
        error: "INVALID_INPUT",
        message: "Check the requested fields and try again.",
      },
      400,
    );
  if (error instanceof MerchantError)
    return response(
      { error: error.code, message: error.message },
      error.code === "NOT_FOUND" ? 404 : 409,
    );
  console.error(
    "Mailbox API failed:",
    error instanceof Error ? error.name : "unknown",
  );
  return response(
    {
      error: "REQUEST_FAILED",
      message:
        "This request could not be completed. Refresh to see the latest state, then try again.",
    },
    500,
  );
}
async function owner() {
  const value = ownerFromSession(
    (await cookies()).get("mailbox_session")?.value,
  );
  if (!value)
    throw new MerchantError(
      "SIGN_IN_REQUIRED",
      "Enter the private demo key to continue.",
    );
  return value;
}
export async function GET(request: NextRequest, context: Context) {
  try {
    const path = (await context.params).route.join("/");
    if (path === "state") {
      let account: string;
      try {
        account = await owner();
      } catch {
        return response({ needsLogin: true }, 401);
      }
      return response(appService().state(account));
    }
    if (path === "services") {
      await owner();
      return response({
        services: await appService().services(
          request.nextUrl.searchParams.get("q") ?? "",
        ),
      });
    }
    if (path === "studio") {
      const account = await owner();
      const agentId = request.nextUrl.searchParams.get("agent_id");
      if (agentId) {
        const agent = appService().store.agent(
          account,
          z.string().uuid().parse(agentId),
        );
        return response({
          layout:
            appService().store.setting(
              `dashboard:${account}:agent:${agent.id}`,
            ) ??
            (agent.template
              ? appService().store.setting(
                  `dashboard:${account}:${agent.template}`,
                )
              : null) ??
            null,
        });
      }
      const niche = z
        .enum(["all", "entertainment", "groceries", "dining", "pets"])
        .parse(request.nextUrl.searchParams.get("niche") ?? "all");
      return response({
        layout:
          appService().store.setting(`dashboard:${account}:${niche}`) ?? null,
      });
    }
    if (path === "paypal/return") {
      const account = await owner(),
        state = request.nextUrl.searchParams.get("state");
      if (!state)
        throw new MerchantError(
          "SETUP_NOT_FOUND",
          "Wallet setup reference is missing.",
        );
      try {
        const p = await appService().finishSetup(account, state);
        const actor =
          p.agent_id ??
          appService().store.wallet(account, p.wallet_id).agent_id;
        return NextResponse.redirect(
          new URL(
            `/?result=${p.status === "PAID" ? "paid" : p.status === "WAITING" ? "armed" : "pending"}${actor ? `&agent=${encodeURIComponent(actor)}` : ""}`,
            request.url,
          ),
        );
      } catch (error) {
        return NextResponse.redirect(
          new URL(
            `/?error=${encodeURIComponent(error instanceof Error ? error.message : "Wallet setup could not be completed.")}`,
            request.url,
          ),
        );
      }
    }
    if (path === "paypal/cancel") {
      const account = await owner(),
        state = request.nextUrl.searchParams.get("state");
      if (state) appService().store.deleteSetup(account, state);
      return NextResponse.redirect(
        new URL("/?result=consent-canceled", request.url),
      );
    }
    return response({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const path = (await context.params).route.join("/"),
      service = appService();
    const raw = await request.text();
    if (raw.length > 262_144)
      return response({ error: "REQUEST_TOO_LARGE" }, 413);
    if (path === "webhooks/agentmail") {
      const signing =
        process.env.AGENTMAIL_WEBHOOK_SECRET ||
        service.store.setting<string>("agentmail_webhook_secret");
      if (!signing) return response({ error: "WEBHOOK_NOT_CONFIGURED" }, 503);
      const headers = {
        "svix-id": request.headers.get("svix-id") ?? "",
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      };
      let event: unknown;
      try {
        event = new Webhook(signing).verify(raw, headers);
      } catch {
        return response({ error: "INVALID_SIGNATURE" }, 401);
      }
      const payload = event as {
        message?: { inbox_id?: string; inboxId?: string };
      };
      const inbox = payload.message?.inbox_id ?? payload.message?.inboxId;
      if (inbox) {
        let matched = false;
        for (const row of service.store.db
          .prepare("SELECT owner,id FROM agents")
          .all()) {
          const agent = service.store.agent(
            row.owner as string,
            row.id as string,
          );
          if (agent.inbox_id === inbox) {
            await syncAgentInbox(service.store, agent);
            matched = true;
          }
        }
        if (!matched)
          for (const row of service.store.db
            .prepare("SELECT body FROM wallets")
            .all()) {
            const wallet = JSON.parse(row.body as string);
            if (wallet.inbox_id === inbox)
              await syncInbox(service.store, wallet);
          }
      }
      return response({ accepted: true });
    }
    if (path !== "command") return response({ error: "NOT_FOUND" }, 404);
    const origin = request.headers.get("origin");
    if (
      origin &&
      origin !== request.nextUrl.origin &&
      origin !== process.env.APP_URL
    )
      return response({ error: "ORIGIN_NOT_ALLOWED" }, 403);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return response({ error: "INVALID_JSON" }, 400);
    }
    const input = commandSchema.parse(data);
    if (input.action === "login") {
      if (!validAccessKey(input.key ?? ""))
        return response(
          {
            error: "ACCESS_DENIED",
            message: "That demo key was not accepted.",
          },
          401,
        );
      const session = createSession();
      const demoOwner = ownerFromSession(session)!;
      await seedMessages(service.store, demoOwner, false);
      const result = response({ signedIn: true });
      result.cookies.set("mailbox_session", session, {
        ...cookieOptions,
        secure: request.nextUrl.protocol === "https:",
      });
      return result;
    }
    if (input.action === "logout") {
      const result = response({ signedOut: true });
      result.cookies.delete("mailbox_session");
      return result;
    }
    const account = await owner();
    if (input.action === "create_agent") {
      if (!input.name || !input.purpose)
        return response(
          {
            error: "AGENT_DETAILS_REQUIRED",
            message: "Give your agent a name and a purpose.",
          },
          400,
        );
      const agent = service.store.createAgent(account, {
        name: input.name,
        purpose: input.purpose,
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.request_id ? { id: input.request_id } : {}),
      });
      return response({ agent: service.store.publicAgent(agent) });
    }
    if (input.action === "connect_agent") {
      const agent = service.store.agent(
        account,
        input.agent_id ?? input.id ?? "",
      );
      return response({
        agent: service.store.publicAgent(
          await provisionAgentAddress(service.store, agent),
        ),
      });
    }
    if (input.action === "update_agent") {
      const agent = service.store.agent(
        account,
        input.agent_id ?? input.id ?? "",
      );
      if (input.name) agent.name = input.name;
      if (input.purpose) agent.purpose = input.purpose;
      if (input.tags) agent.tags = input.tags;
      service.store.saveAgent(agent);
      return response({ agent: service.store.publicAgent(agent) });
    }
    if (input.action === "studio_turn")
      return response(await studioTurn(input.turn));
    if (input.action === "studio_save") {
      if (!input.layout || (!input.niche && !input.agent_id))
        return response(
          {
            error: "INVALID_LAYOUT",
            message: "Choose a niche and a dashboard layout.",
          },
          400,
        );
      if (input.agent_id) service.store.agent(account, input.agent_id);
      service.store.setSetting(
        input.agent_id
          ? `dashboard:${account}:agent:${input.agent_id}`
          : `dashboard:${account}:${input.niche}`,
        input.layout,
      );
      return response({ saved: true });
    }
    if (input.action === "market_search") {
      if (input.agent_id) service.store.agent(account, input.agent_id);
      const result = await searchMarket(input.text ?? "");
      service.store.log(
        account,
        "MARKET_SEARCH",
        "Product discovery through Channel3. No spending authority created.",
      );
      return response(result);
    }
    if (input.action === "seed_preview" || input.action === "seed_live")
      return response(
        await seedMessages(
          service.store,
          account,
          input.action === "seed_live",
        ),
      );
    if (input.action === "reset") {
      await service.reset(account);
      const result = response({ reset: true, paymentsRetained: true });
      result.cookies.set("mailbox_session", createSession(), {
        ...cookieOptions,
        secure: request.nextUrl.protocol === "https:",
      });
      return result;
    }
    const id = () => {
      if (!input.id)
        throw new MerchantError(
          "INVALID_INPUT",
          "Choose the service or proposal first.",
        );
      return input.id;
    };
    if (input.action === "ask")
      return response(
        await service.ask(
          account,
          input.text ?? "",
          input.example,
          input.agent_id,
        ),
      );
    if (input.action === "propose") {
      if (!input.service_id)
        throw new MerchantError("INVALID_INPUT", "Choose a service.");
      return response({
        type: "proposal",
        proposal: await service.propose(
          account,
          input.service_id,
          input.kind ?? "buy",
          input.agent_id ? { agent_id: input.agent_id } : {},
        ),
      });
    }
    if (input.action === "approve")
      return response(await service.approve(account, id(), input.rules));
    if (input.action === "decline")
      return response({
        type: "proposal",
        proposal: service.decline(account, id()),
      });
    if (input.action === "rules") {
      if (!input.rules)
        throw new MerchantError("INVALID_INPUT", "Enter wallet limits.");
      return response({
        wallet: service.updateRules(account, id(), input.rules),
      });
    }
    if (input.action === "pause")
      return response({
        wallet: service.pause(account, id(), input.paused ?? true),
      });
    if (input.action === "revoke")
      return response({ wallet: await service.revoke(account, id()) });
    if (input.action === "reconnect")
      return response({ wallet: service.reconnect(account, id()) });
    if (input.action === "cancel")
      return response({ proposal: await service.cancel(account, id()) });
    if (input.action === "sync") return response(await service.sync(account));
    return response({ error: "UNKNOWN_ACTION" }, 400);
  } catch (error) {
    return failure(error);
  }
}
