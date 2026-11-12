import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const data = mkdtempSync(join(tmpdir(), "mailbox-browser-"));
const port = Number(process.env.MAILBOX_BROWSER_PORT ?? 3400);
const origin = `http://127.0.0.1:${port}`;
const sharedOrigin = `http://127.0.0.1:${port + 1}`;
const agentOrigin = `http://127.0.0.1:${port + 2}`;
const buildDir = process.env.MAILBOX_BROWSER_BUILD_DIR ?? ".next-qa";
const isolatedServer = {
  command: `npm run start:web -- --port ${port} --hostname 127.0.0.1`,
  url: origin,
  reuseExistingServer: false,
  timeout: 60000,
  env: {
    NODE_ENV: "production",
    // Legacy hosted settings must no longer disable the dashboard.
    MAILBOX_ENABLE_AG_STUDIO: "false",
    NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY: "",
    MAILBOX_BUILD_DIR: buildDir,
    MAILBOX_RUN_WORKER: "0",
    APP_URL: origin,
    MOCK_MERCHANT_URL: origin,
    APP_DATABASE_PATH: join(data, "app.sqlite"),
    MOCK_DATABASE_PATH: join(data, "merchant.sqlite"),
    APP_SESSION_SECRET: "browser-test-session-secret-with-over-32-characters",
    DEMO_ACCESS_KEY: "mailbox-browser-test-access",
    DEMO_WORKSPACE_ID: "",
    MOCK_MERCHANT_TOKEN: "browser-test-mcp-secret-with-over-32-characters",
    MOCK_ADMIN_TOKEN: "browser-test-admin-secret-with-over-32-characters",
    PAYPAL_CLIENT_ID: "",
    PAYPAL_CLIENT_SECRET: "",
    PAYPAL_MERCHANT_ID: "",
    PAYPAL_WEBHOOK_ID: "",
    AGENTMAIL_API_KEY: "",
    AGENTMAIL_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 1).toString("base64")}`,
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    AI_PROVIDER: "openai",
    CHANNEL3_API_KEY: "",
    RENDER_API_KEY: "",
  },
};
export default defineConfig({
  testDir: "browser-tests",
  outputDir: process.env.MAILBOX_BROWSER_OUTPUT_DIR ?? join(data, "results"),
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
  projects: [
    { name: "isolated", testMatch: "app.spec.ts" },
    {
      name: "agent",
      testMatch: /(?:agent|dashboard)\.spec\.ts/,
      use: { baseURL: agentOrigin },
    },
    {
      name: "shared",
      testMatch: "shared.spec.ts",
      use: { baseURL: sharedOrigin },
    },
  ],
  webServer: [
    isolatedServer,
    {
      ...isolatedServer,
      command: `npm run start:web -- --port ${port + 2} --hostname 127.0.0.1`,
      url: agentOrigin,
      env: {
        ...isolatedServer.env,
        APP_URL: agentOrigin,
        MOCK_MERCHANT_URL: agentOrigin,
        APP_DATABASE_PATH: join(data, "agent-app.sqlite"),
        MOCK_DATABASE_PATH: join(data, "agent-merchant.sqlite"),
        OPENAI_API_KEY: "fixture-agent-provider-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${port + 12}/v1`,
      },
    },
    {
      ...isolatedServer,
      command: `npm run start:web -- --port ${port + 1} --hostname 127.0.0.1`,
      url: sharedOrigin,
      env: {
        ...isolatedServer.env,
        APP_URL: sharedOrigin,
        MOCK_MERCHANT_URL: sharedOrigin,
        APP_DATABASE_PATH: join(data, "shared-app.sqlite"),
        MOCK_DATABASE_PATH: join(data, "shared-merchant.sqlite"),
        DEMO_WORKSPACE_ID: "44de23ae-790d-4e63-bb52-28f73e28803d",
      },
    },
  ],
});
