import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
const path = new URL("../.env", import.meta.url),
  template = new URL("../.env.example", import.meta.url);
if (existsSync(path) && lstatSync(path).isSymbolicLink())
  throw new Error(
    "Keep this project .env as a private regular file; the setup command will not overwrite a linked file.",
  );
let text = existsSync(path)
  ? readFileSync(path, "utf8")
  : readFileSync(template, "utf8");
for (const name of [
  "APP_SESSION_SECRET",
  "MOCK_MERCHANT_TOKEN",
  "MOCK_ADMIN_TOKEN",
  "DEMO_ACCESS_KEY",
]) {
  const pattern = new RegExp(`^${name}=(.*)$`, "m"),
    current = pattern.exec(text)?.[1]?.trim();
  if (!current || /^(generate_|choose_)/.test(current)) {
    const line = `${name}=${randomBytes(32).toString("hex")}`;
    text = pattern.test(text)
      ? text.replace(pattern, line)
      : `${text}\n${line}\n`;
  }
}
writeFileSync(path, text, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(
  "Private .env ready. Existing credentials were preserved. Fill the service placeholders, then read DEMO_ACCESS_KEY locally to sign in.",
);
