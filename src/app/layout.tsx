import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
// Entry stylesheet: pulls globals.css into the `legacy` cascade layer and
// adds Tailwind's theme + utilities layers on top. See styles.css.
import "./styles.css";
import { SiteFooter } from "@/components/SiteFooter";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hand Receipt",
  description: "Digital hand receipts — track custody of equipment with a signed transfer chain.",
  verification: {
    google: 'x_sRcTGltoMpbYm8ZCvfxlFIT92stDJQrKzlzTC5eZo',
  },
  // iOS reads these for "Add to Home Screen" — it does not honour the web app
  // manifest's `display`/`name`. Without `capable`, the icon opens in a Safari
  // view with browser chrome instead of as a standalone app. See
  // `src/app/manifest.ts` for the rest of the install metadata.
  appleWebApp: {
    capable: true,
    title: "Hand Receipt",
    statusBarStyle: "default",
  },
  other: {
    // `appleWebApp.capable` emits the STANDARDISED `mobile-web-app-capable`
    // (verified in the rendered head; Next dropped the Apple-prefixed name
    // because it is deprecated). Recent iOS is happy with that, or with the
    // manifest's own `display: standalone` — but older iPhones read ONLY
    // `apple-mobile-web-app-capable`, and without it they install the icon as a
    // plain Safari tab. This is a duplicate on purpose; it is one tag, and the
    // failure it prevents is silent.
    "apple-mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the manifest's `theme_color` (--primary), so the iOS status bar
  // and the Android address bar pick up the ledger palette.
  themeColor: "#1d4e6f",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // suppressHydrationWarning on <html>: browser extensions inject attributes
  // before React hydrates (observed: __gcrremoteframetoken from a remote-access
  // extension), which React reports as a mismatch it "won't patch up". Nothing
  // in this app writes those attributes. It suppresses attribute mismatches on
  // THAT ELEMENT ONLY - one level deep, not a subtree switch - so a real
  // mismatch anywhere inside is still reported.
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body>
        <div className="app-shell">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
