import { Channel3 } from "@channel3/sdk";
import { MerchantError } from "@mailbox/service-sdk";
import { z } from "zod";
import { configured } from "./ai.ts";

export type MarketProduct = {
  id: string;
  title: string;
  brand: string;
  image: string | null;
  offers: {
    url: string;
    merchant: string;
    amount: number;
    currency: string;
    affiliate: boolean;
  }[];
};
export type MarketResult = {
  type: "market";
  query: string;
  products: MarketProduct[];
  source: "Channel3";
  country: "US";
  checked_at: string;
};
function httpsUrl(value: string | null | undefined) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export async function searchMarket(
  query: string,
  request: typeof fetch = fetch,
): Promise<MarketResult> {
  query = z.string().trim().min(2).max(500).parse(query);
  if (!configured("CHANNEL3_API_KEY"))
    throw new MerchantError(
      "MARKET_NOT_CONFIGURED",
      "Market search needs a Channel3 connection. You can still search your connected services.",
    );
  const client = new Channel3({
    apiKey: process.env.CHANNEL3_API_KEY!,
    fetch: request,
    timeoutInSeconds: 20,
    maxRetries: 0,
  });
  let page;
  try {
    page = await client.products.search({
      query,
      limit: 8,
      filters: { availability: ["InStock"] },
      config: {
        country: "US",
        currency: "USD",
        language: "en",
        mode: "agentic",
      },
    });
  } catch {
    throw new MerchantError(
      "MARKET_UNAVAILABLE",
      "Channel3 could not return products. Check the connection or try again; no purchase was prepared.",
    );
  }
  const products = page.data
    .slice(0, 8)
    .map((product): MarketProduct => ({
      id: product.id,
      title: product.title,
      brand: product.brands?.map((b) => b.name).join(", ") ?? "",
      image: httpsUrl(
        product.images?.[0]?.cleaned_url ?? product.images?.[0]?.url,
      ),
      offers: (product.offers ?? [])
        .flatMap((offer) => {
          const url = httpsUrl(offer.url);
          const amount = offer.price?.price;
          if (
            !url ||
            offer.availability !== "InStock" ||
            !Number.isFinite(amount) ||
            amount < 0 ||
            !/^[A-Z]{3}$/.test(offer.price.currency)
          )
            return [];
          return [
            {
              url,
              merchant: offer.domain || new URL(url).hostname,
              amount,
              currency: offer.price.currency,
              affiliate: (offer.max_commission_rate ?? 0) > 0,
            },
          ];
        })
        .sort((a, b) =>
          a.currency === b.currency
            ? a.amount - b.amount
            : a.currency.localeCompare(b.currency),
        ),
    }))
    .filter((product) => product.offers.length > 0);
  return {
    type: "market",
    source: "Channel3",
    query,
    products,
    country: "US",
    checked_at: new Date().toISOString(),
  };
}
