import { z } from "zod";

export const itemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  amount_minor: z.number().int().positive(),
  period: z.enum(["once", "month"]),
  includes: z.array(z.string()).default([]),
  terms: z.string().min(1),
  in_stock: z.boolean().default(true),
  unit_quantity: z.number().int().positive().optional(),
  unit: z.enum(["g", "ml", "each"]).optional(),
  comparison_group: z.string().optional(),
  access_hours: z
    .number()
    .int()
    .positive()
    .max(24 * 366)
    .optional(),
});
export const serviceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1),
  category: z.string().min(1),
  kind: z.enum(["subscription", "purchase", "booking"]),
  description: z.string(),
  items: z.array(itemSchema).min(1),
  paypalMerchant: z.string().min(1),
  booking: z
    .object({
      weekday: z.number().int().min(0).max(6),
      times: z.array(z.string().regex(/^\d{2}:\d{2}$/)).min(1),
      capacity: z.number().int().positive(),
      timezone: z.literal("Asia/Dubai"),
    })
    .optional(),
});
export type Service = z.infer<typeof serviceSchema>;
export type Item = z.infer<typeof itemSchema>;
export function createService(config: {
  id: string;
  name: string;
  category: string;
  description?: string;
  paypalMerchant: string;
  catalogue?: z.input<typeof itemSchema>[];
  plans?: z.input<typeof itemSchema>[];
  booking?: {
    weekday: number;
    times: string[];
    capacity: number;
    timezone: "Asia/Dubai";
  };
}): Service {
  if (config.plans?.length && config.catalogue?.length)
    throw new Error("A service must define plans or a catalogue, not both.");
  const kind = config.plans?.length
    ? "subscription"
    : config.booking
      ? "booking"
      : "purchase";
  if (config.plans?.some((plan) => plan.period !== "month"))
    throw new Error(
      "This SDK currently supports one-month subscription plans.",
    );
  return serviceSchema.parse({
    ...config,
    kind,
    description: config.description ?? "",
    items: config.plans ?? config.catalogue,
  });
}

export class MerchantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function addBillingMonth(iso: string): string {
  const start = new Date(iso),
    end = new Date(start);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
  ).getUTCDate();
  end.setUTCDate(Math.min(start.getUTCDate(), last));
  return end.toISOString();
}
