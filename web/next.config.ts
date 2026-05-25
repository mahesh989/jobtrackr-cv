import type { NextConfig } from "next";

// Baseline security headers applied to every route.
//
// The Content-Security-Policy here intentionally restricts only
// framing / base-uri / object / form targets. Those directives do NOT affect
// script or style loading, so they are safe to ship without a nonce rollout.
// A content-restricting CSP (script-src / style-src / connect-src) is the
// natural next step but must be validated against the live app first — Next.js
// injects inline scripts (and there's an inline theme-FOUC guard in layout.tsx),
// so it needs per-request nonces or 'unsafe-inline' to avoid breaking hydration.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
