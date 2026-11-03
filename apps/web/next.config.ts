import type { NextConfig } from "next";

try {
  process.loadEnvFile("../../.env"); // one .env at the repo root for every package
} catch {
  // no .env: rely on the real environment
}

const nextConfig: NextConfig = {
  transpilePackages: ["@kanbot/shared"],
  // The e2e server builds into its own dir: Next allows one dev server per dist dir.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
