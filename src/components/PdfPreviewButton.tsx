"use client";

import { useState } from "react";
import { isStandaloneDisplay } from "@/lib/standalone";
import { PdfPreviewOverlay } from "./PdfPreviewOverlay";

/**
 * A link to an inline PDF that stays inside the app when the app is INSTALLED.
 *
 * Renders exactly the anchor it replaces — same class, same target, same rel —
 * so a browser tab's behaviour is unchanged and the server output is identical.
 * Only in a standalone install does it swallow its own click and open
 * `PdfPreviewOverlay` instead, because that is the only context with no back
 * button to return with.
 *
 * The standalone check runs at CLICK time rather than in a `useState` +
 * `useEffect` pair. That means no hydration flash and no re-render — the same
 * reasoning as `AppHeader`, which renders both navs and lets CSS choose rather
 * than checking the viewport in JS. The cost is that a tap landing before
 * hydration falls through to the browser path, which is exactly today's
 * behaviour and so cannot be a regression.
 */
export function PdfPreviewButton({
  href,
  title,
  label,
  className = "btn btn-secondary",
  rel = "noopener noreferrer",
  offerNativeViewer = false,
}: {
  href: string;
  /** Shown in the overlay's bar, and used as the iframe's accessible name. */
  title: string;
  label: string;
  className?: string;
  rel?: string;
  /** See PdfPreviewOverlay — true for the QR surfaces only. */
  offerNativeViewer?: boolean;
}) {
  // Null until opened: the overlay renders no iframe without it, so no page
  // load pays for a server-side PDF render it may never show.
  const [src, setSrc] = useState<string | null>(null);

  return (
    <>
      <a
        className={className}
        href={href}
        target="_blank"
        rel={rel}
        onClick={(e) => {
          if (!isStandaloneDisplay()) return;
          e.preventDefault();
          setSrc(href);
        }}
      >
        {label}
      </a>
      <PdfPreviewOverlay
        src={src}
        title={title}
        offerNativeViewer={offerNativeViewer}
        onClose={() => setSrc(null)}
      />
    </>
  );
}
