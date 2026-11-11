import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MerchantError } from "@mailbox/service-sdk";
import { secretReady } from "./secret-config.ts";
const age = 7 * 24 * 60 * 60;
function secret() {
  const value = process.env.APP_SESSION_SECRET;
  if (!secretReady(value))
    throw new MerchantError(
      "AUTH_NOT_CONFIGURED",
      "Private app access is not configured.",
    );
  return value;
}
export function createSession() {
  const value = `${randomUUID()}.${Math.floor(Date.now() / 1000) + age}`;
  return `${value}.${createHmac("sha256", secret()).update(value).digest("hex")}`;
}
export function ownerFromSession(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [owner, expiry, signature] = parts;
  if (!owner || !expiry || !signature || Number(expiry) < Date.now() / 1000)
    return null;
  const value = `${owner}.${expiry}`,
    expected = createHmac("sha256", secret()).update(value).digest("hex");
  const a = Buffer.from(signature),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? owner : null;
}
export function validAccessKey(value: string) {
  const expected = process.env.DEMO_ACCESS_KEY;
  if (!secretReady(expected, 16)) return false;
  const a = Buffer.from(value),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: age,
};
