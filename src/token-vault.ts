import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { MerchantError } from "@mailbox/service-sdk";
function key(secret: string | undefined) {
  if (!secret || secret.length < 32)
    throw new MerchantError(
      "VAULT_KEY_REQUIRED",
      "The private application key is required to store a payment connection.",
    );
  return createHash("sha256").update(secret).digest();
}
export function encryptToken(value: string, secret: string | undefined) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "enc",
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}
export function decryptToken(value: string, secret: string | undefined) {
  if (!value.startsWith("enc:v1:")) return value;
  const parts = value.split(":");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(secret),
      Buffer.from(parts[2]!, "hex"),
    );
    decipher.setAuthTag(Buffer.from(parts[3]!, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4]!, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new MerchantError(
      "VAULT_LOCKED",
      "The saved payment connection could not be unlocked. Restore the private application key before reconnecting.",
    );
  }
}
