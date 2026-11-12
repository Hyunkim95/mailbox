import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { MerchantError } from "@mailbox/service-sdk";
import { secretReady } from "./secret-config.ts";

export async function merchantTool<T>(
  serviceId: string | null,
  name: string,
  args: Record<string, unknown> = {},
  baseOverride?: string,
): Promise<T> {
  const base =
    baseOverride ??
    process.env.MOCK_MERCHANT_URL ??
    `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const token = process.env.MOCK_MERCHANT_TOKEN;
  const endpoint = new URL(base);
  if (
    endpoint.username ||
    endpoint.password ||
    !(
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    )
  )
    throw new MerchantError(
      "MERCHANT_ENDPOINT_INVALID",
      "Use an HTTPS service connection or a local development endpoint.",
    );
  if (!secretReady(token))
    throw new MerchantError(
      "MERCHANT_NOT_CONFIGURED",
      "The service connection is not configured.",
    );
  const client = new Client({ name: "mailbox-consumer", version: "0.1.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`/mcp${serviceId ? `/${serviceId}` : ""}`, base),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
      ),
    );
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) {
      const error = result.structuredContent as
        { code?: string; message?: string } | undefined;
      throw new MerchantError(
        error?.code ?? "MERCHANT_ERROR",
        error?.message ?? "The service could not complete that action.",
      );
    }
    return (result.structuredContent as { data: T }).data;
  } finally {
    await client.close();
  }
}
