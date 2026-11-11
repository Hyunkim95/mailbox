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
export function createSession(owner: string = randomUUID()) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      owner,
    )
  )
    throw new MerchantError(
      "INVALID_WORKSPACE",
      "The demo workspace is not configured correctly.",
    );
  const value = `${owner}.${Math.floor(Date.now() / 1000) + age}`;
  return `${value}.${createHmac("sha256", secret()).update(value).digest("hex")}`;
}
export function createDemoSession() {
  return createSession(process.env.DEMO_WORKSPACE_ID?.trim() || undefined);
}
export function isSharedDemoOwner(owner: string) {
  return (
    !!process.env.DEMO_WORKSPACE_ID?.trim() &&
    owner === process.env.DEMO_WORKSPACE_ID.trim()
  );
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
