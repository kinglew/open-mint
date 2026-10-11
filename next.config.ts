import type { NextConfig } from "next";

// Static, client-only export: no server, no API routes, no database.
// All user data lives in the browser (SQLite WASM in OPFS).
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
