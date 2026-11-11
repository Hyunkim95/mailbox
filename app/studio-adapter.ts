"use client";
import type { AgAiEvent, AgLlmAdapter, AgLlmResponse } from "ag-studio";
export const studioAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const complete = fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "studio_turn", turn: request }),
      ...(options?.signal ? { signal: options.signal } : {}),
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.message ?? "Dashboard customization is unavailable.",
        );
      return body as AgLlmResponse;
    });
    async function* stream(): AsyncGenerator<AgAiEvent> {
      const response = await complete;
      for (const item of response.output) {
        if (item.type === "message") {
          yield {
            type: "TEXT_MESSAGE_START",
            messageId: item.id,
            role: "assistant",
          };
          for (const part of item.content)
            if (part.type === "text")
              yield {
                type: "TEXT_MESSAGE_CONTENT",
                messageId: item.id,
                delta: part.text,
              };
          yield { type: "TEXT_MESSAGE_END", messageId: item.id };
        } else if (item.type === "function_call") {
          yield {
            type: "TOOL_CALL_START",
            toolCallId: item.callId,
            toolCallName: item.name,
          };
          yield {
            type: "TOOL_CALL_ARGS",
            toolCallId: item.callId,
            delta: item.arguments,
          };
          yield { type: "TOOL_CALL_END", toolCallId: item.callId };
        }
      }
    }
    return { complete, stream: { [Symbol.asyncIterator]: stream } };
  },
};
