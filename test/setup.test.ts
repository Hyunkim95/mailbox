import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
test("fresh local setup generates private keys and preserves them and existing service credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "mailbox-setup-"));
  try {
    mkdirSync(join(directory, "scripts"));
    copyFileSync(
      "scripts/setup-local.mjs",
      join(directory, "scripts/setup-local.mjs"),
    );
    copyFileSync(".env.example", join(directory, ".env.example"));
    const script = join(directory, "scripts/setup-local.mjs");
    execFileSync(process.execPath, [script]);
    const path = join(directory, ".env"),
      first = readFileSync(path, "utf8");
    assert(!first.includes("=generate_a_"));
    assert(!first.includes("=choose_a_demo_"));
    const customized = first.replace(
      "your_openai_api_key",
      "fixture-provider-key-to-preserve",
    );
    writeFileSync(path, customized);
    execFileSync(process.execPath, [script]);
    assert.equal(readFileSync(path, "utf8"), customized);
    if (process.platform !== "win32")
      assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
