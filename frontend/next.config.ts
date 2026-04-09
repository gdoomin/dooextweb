import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

function readAppVersion(): string {
  try {
    const versionFilePath = path.join(process.cwd(), "..", "ver.md");
    const raw = fs.readFileSync(versionFilePath, "utf8");
    const matched = raw.match(/Current Version:\s*`([^`]+)`/);
    return matched?.[1]?.trim() || "dev";
  } catch {
    return "dev";
  }
}

const appVersion = readAppVersion();

const htmlNoStoreHeader = {
  key: "Cache-Control",
  value: "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
};

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  async headers() {
    return [
      {
        source: "/",
        headers: [htmlNoStoreHeader],
      },
      {
        source: "/jobs",
        headers: [htmlNoStoreHeader],
      },
      {
        source: "/login",
        headers: [htmlNoStoreHeader],
      },
      {
        source: "/preview",
        headers: [htmlNoStoreHeader],
      },
      {
        source: "/reset-password",
        headers: [htmlNoStoreHeader],
      },
      {
        source: "/admin/popup",
        headers: [htmlNoStoreHeader],
      },
    ];
  },
};

export default nextConfig;
