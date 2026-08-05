import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
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
