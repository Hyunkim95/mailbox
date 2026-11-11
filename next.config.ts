import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.MAILBOX_BUILD_DIR ?? ".next",
  serverExternalPackages: ["@mailbox/service-sdk", "agentmail"],
  poweredByHeader: false,
  devIndicators: false,
};
export default config;
