import raw from "../fixtures/catalogue.json" with { type: "json" };
import { createService, itemSchema } from "@mailbox/service-sdk";

const paypalMerchant =
  process.env.PAYPAL_MERCHANT_ID &&
  !process.env.PAYPAL_MERCHANT_ID.startsWith("your_")
    ? process.env.PAYPAL_MERCHANT_ID
    : "FIXTURE-MERCHANT";
export const catalogue = {
  merchant: raw.merchant,
  currency: "USD" as const,
  services: raw.services.map((service) =>
    createService({
      id: service.id,
      name: service.name,
      category: service.category,
      description: service.description,
      paypalMerchant,
      ...(service.kind === "subscription"
        ? { plans: service.items.map((item) => itemSchema.parse(item)) }
        : { catalogue: service.items.map((item) => itemSchema.parse(item)) }),
      ...("booking" in service && service.booking
        ? { booking: { ...service.booking, timezone: "Asia/Dubai" as const } }
        : {}),
    }),
  ),
};
