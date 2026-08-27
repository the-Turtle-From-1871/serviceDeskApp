import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Dev only. Next blocks cross-origin requests to dev-only assets and
  // endpoints, so reaching `next dev` from another device over Tailscale fails
  // without listing that device's view of this host here. Bare hostnames, no
  // scheme or port. Ignored by `next build` / `next start`.
  allowedDevOrigins: ["primary", "primary.tailfefa09.ts.net", "100.85.95.24"],
  // Typing `primary:3000` on a phone gives a PLAIN HTTP origin, and browsers
  // only expose getUserMedia in a secure context - so the QR scanner reports
  // "camera not available" there. Bounce that host to the Tailscale HTTPS name,
  // which has a real certificate, so the short address still works AND lands on
  // an origin the camera is allowed on.
  //
  // 307 (permanent: false) on purpose: a 301 is cached by the browser more or
  // less forever, which would be painful to undo if the hostname ever changes.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "primary" }],
        destination: "https://primary.tailfefa09.ts.net/:path*",
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        // Reset/forgot flows carry a raw token in the URL; suppress the
        // Referer header so referenced resources can't leak it cross-origin.
        source: "/:path(reset-password|forgot-password)",
        headers: [
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
        ],
      },
      {
        // The receipt-link token (docs/SECURITY.md §3) puts a non-expiring
        // capability directly in the URL as `?k=<token>`, same shape as the
        // reset token above but with more at stake: the proxy strips it from
        // the address bar only on the anonymous, PIN-locked path, so a
        // logged-in technician or an already-unlocked visitor keeps it in the
        // URL for the whole visit — and unlike the reset token, this one
        // never expires. Suppress the Referer header so any subresource or
        // outbound link on the page can't leak it cross-origin.
        // `/i/*` is deliberately NOT covered: no token is ever put on an item
        // URL, so there is nothing there to protect.
        source: "/receipts/:path*",
        headers: [
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
