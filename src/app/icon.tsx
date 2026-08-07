import { ImageResponse } from "next/og";

// The PWA/browser app icon, generated rather than checked in as a binary so it
// stays in step with the ledger palette in `globals.css` (`--primary`).
//
// 512 because that is the largest size a web app manifest is expected to
// carry, and Chrome's installability check needs at least one icon >= 192.
// `apple-icon.tsx` is the iOS home-screen counterpart at 180.

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          // Full-bleed on purpose: iOS composites a transparent icon onto
          // black and applies its own rounding, so the icon must supply its
          // own opaque background.
          background: "#1d4e6f",
          color: "#ffffff",
          fontSize: 210,
          fontWeight: 700,
          letterSpacing: -8,
        }}
      >
        HR
      </div>
    ),
    { ...size },
  );
}
