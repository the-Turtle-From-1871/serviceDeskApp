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
    ];
  },
};

export default nextConfig;
