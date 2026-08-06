import type { MetadataRoute } from "next";

// Web app manifest — what makes "Add to Home Screen" install a real app
// (proper name and icon, standalone window) instead of a Safari bookmark.
//
// Deliberately NOT a PWA in the offline sense: there is no service worker and
// no cached shell. Every page here is a Server Component reading live custody
// data, and a stale cached property book is worse than an error — a technician
// must never be shown yesterday's holder for a device.
//
// NOTE: `/manifest.webmanifest`, `/icon` and `/apple-icon` are excluded from
// the proxy matcher in `src/proxy.ts`. They have to be: the coarse login gate
// redirects any matched path to `/login` when logged out, so an iPhone
// installing the app would have received an HTML redirect instead of JSON and
// silently fallen back to defaults.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hand Receipt",
    short_name: "Hand Receipt",
    description:
      "Digital hand receipts — track custody of equipment with a signed transfer chain.",
    // `/` and not `/items`: it is the one page outside the PIN gate, and it is
    // the page that explains what the app is. A recipient who installs the
    // icon and a technician who does should both land somewhere that works.
    start_url: "/",
    display: "standalone",
    background_color: "#e3e8df", // --bg
    theme_color: "#1d4e6f", // --primary
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
      { src: "/favicon.ico", sizes: "any", type: "image/x-icon" },
    ],
  };
}
