import { ImageResponse } from "next/og";

// The iOS home-screen icon. Next emits `<link rel="apple-touch-icon">` for
// this file convention, which is what "Add to Home Screen" reads — without it
// iOS screenshots the page and uses that as the icon.
//
// 180 is the size iOS asks for; it rounds the corners itself, so this draws
// full-bleed and square. Same monogram as `icon.tsx`, kept in the ledger
// palette (`--primary` in `globals.css`).

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1d4e6f",
          color: "#ffffff",
          fontSize: 74,
          fontWeight: 700,
          letterSpacing: -3,
        }}
      >
        HR
      </div>
    ),
    { ...size },
  );
}
