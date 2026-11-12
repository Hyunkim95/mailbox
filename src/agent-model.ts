import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MerchantError } from "@mailbox/service-sdk";
import { modelName, modelProvider, modelReady } from "./ai.ts";
import {
  agentInstructions,
  agentTools,
  type AgentCall,
  type AgentExchange,
} from "./agent-tools.ts";

export type AgentTurn = (
  context: unknown,
  history: AgentExchange[],
) => Promise<AgentCall>;

/** Both providers use native tool calls. No scenario label is requested. */
export async function nextAgentTurn(
  context: unknown,
  history: AgentExchange[],
  request: typeof fetch = fetch,
): Promise<AgentCall> {
  if (!modelReady())
    throw new MerchantError(
      "MODEL_NOT_CONFIGURED",
      "Connect a model to let the agent work through your request, including suggestions.",
    );
  const definitions = Object.entries(agentTools).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.input),
  }));
  if (modelProvider() === "anthropic") {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!,
      fetch: request,
      timeout: 25000,
      maxRetries: 1,
    });
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: JSON.stringify(context) },
    ];
    for (const entry of history) {
      messages.push({
        role: "assistant",
        content: (entry.call.continuation as
          Anthropic.ContentBlockParam[] | undefined) ?? [
          {
            type: "tool_use",
            id: entry.call.id,
            name: entry.call.name,
            input: entry.call.arguments as Record<string, unknown>,
          },
        ],
      });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: entry.call.id,
            content: JSON.stringify(entry.result),
          },
        ],
      });
    }
    const response = await client.messages.create({
      model: modelName(),
      max_tokens: 4096,
      system: agentInstructions,
      messages,
      tools: definitions.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    });
    const calls = response.content.filter((block) => block.type === "tool_use");
    if (response.stop_reason !== "tool_use" || calls.length !== 1)
      throw incomplete();
    const call = calls[0]!;
    return {
      id: call.id,
      name: call.name,
      arguments: call.input,
      continuation: response.content,
    };
  }
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    fetch: request,
    timeout: 25000,
    maxRetries: 1,
  });
  const input: OpenAI.Responses.ResponseInput = [
    { role: "user", content: JSON.stringify(context) },
  ];
  for (const entry of history) {
    input.push(
      ...((entry.call.continuation as
        OpenAI.Responses.ResponseInputItem[] | undefined) ?? [
        {
          type: "function_call" as const,
          call_id: entry.call.id,
          name: entry.call.name,
          arguments: JSON.stringify(entry.call.arguments),
        },
      ]),
    );
    input.push({
      type: "function_call_output",
      call_id: entry.call.id,
      output: JSON.stringify(entry.result),
    });
  }
  const response = await client.responses.create({
    model: modelName(),
    instructions: agentInstructions,
    input,
    tools: definitions.map((t) => ({ type: "function", ...t, strict: true })),
    tool_choice: "required",
    parallel_tool_calls: false,
    max_output_tokens: 4096,
    include: ["reasoning.encrypted_content"],
    store: false,
  });
  const calls = response.output.filter((item) => item.type === "function_call");
  if (response.status !== "completed" || calls.length !== 1) throw incomplete();
  const call = calls[0]!;
  try {
    return {
      id: call.call_id,
      name: call.name,
      arguments: JSON.parse(call.arguments),
      continuation: response.output,
    };
  } catch {
    throw incomplete();
  }
}
function incomplete() {
  return new MerchantError(
    "MODEL_RESPONSE_INCOMPLETE",
    "The agent could not choose a complete next step. Please try again.",
  );
}
