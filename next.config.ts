import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.MAILBOX_BUILD_DIR ?? ".next",
  serverExternalPackages: ["@mailbox/service-sdk", "agentmail"],
  poweredByHeader: false,
  devIndicators: false,
  turbopack: {
    resolveAlias: {
      "@mailbox/dashboard":
        process.env.MAILBOX_ENABLE_AG_STUDIO === "false"
          ? "./app/dashboard-unavailable.tsx"
          : "./app/niche-dashboard.tsx",
    },
  },
};
export default config;
