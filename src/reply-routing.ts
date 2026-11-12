import { z } from "zod";
import type { Message } from "./app-model.ts";

/** Exact envelope recipients shown in review and passed explicitly to the provider. */
export function replyAddresses(
  message: Pick<Message, "from" | "reply_to">,
): string[] {
  const headers = message.reply_to?.length ? message.reply_to : [message.from];
  const addresses = headers.map((header) => {
    const value =
      header.match(/^[^<>]*<([^<>]+)>\s*$/)?.[1]?.trim() ?? header.trim();
    return z.email().safeParse(value).success ? value : null;
  });
  return addresses.length && addresses.every((a): a is string => a !== null)
    ? [...new Set(addresses)]
    : [];
}
