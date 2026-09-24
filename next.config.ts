import type { NextConfig } from "next";

// The Express backend (orders, decisions, auth, sync).
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

const nextConfig: NextConfig = {
  // Proxy the API through this app, so the browser only ever talks to one
  // origin: no CORS setup on the backend, and the same /api paths as before.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
  // The Stock page used to be "Low stock"; keep old bookmarks working.
  async redirects() {
    return [{ source: "/low-stock", destination: "/stock", permanent: false }];
  },
};

export default nextConfig;
