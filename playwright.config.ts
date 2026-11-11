import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const data = mkdtempSync(join(tmpdir(), "mailbox-browser-"));
const origin = "http://127.0.0.1:3400";
export default defineConfig({
  testDir: "browser-tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: origin,
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start:web -- --port 3400 --hostname 127.0.0.1",
    url: origin,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      NODE_ENV: "production",
      MAILBOX_BUILD_DIR: ".next-qa",
      MAILBOX_RUN_WORKER: "0",
      APP_URL: origin,
      MOCK_MERCHANT_URL: origin,
      APP_DATABASE_PATH: join(data, "app.sqlite"),
      MOCK_DATABASE_PATH: join(data, "merchant.sqlite"),
      APP_SESSION_SECRET: "browser-test-session-secret-with-over-32-characters",
      DEMO_ACCESS_KEY: "mailbox-browser-test-access",
      MOCK_MERCHANT_TOKEN: "browser-test-mcp-secret-with-over-32-characters",
      MOCK_ADMIN_TOKEN: "browser-test-admin-secret-with-over-32-characters",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_MERCHANT_ID: "",
      PAYPAL_WEBHOOK_ID: "",
      AGENTMAIL_API_KEY: "",
      AGENTMAIL_WEBHOOK_SECRET: "",
      OPENAI_API_KEY: "",
      RENDER_API_KEY: "",
    },
  },
});
