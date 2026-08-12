"use client";

import { useEffect, useRef } from "react";
import { downloadHref } from "./pdf-preview-url";

/**
 * A full-screen in-app PDF viewer, for the INSTALLED app only.
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 * Every PDF this app previews is served `Content-Disposition: inline`, so the
 * browser navigates to a raw application/pdf response. iOS collapses
 * `target="_blank"` into the same browsing context for a standalone install,
 * and a standalone window has no tab strip, no address bar and no back button —
 * so the user was stranded on the PDF with nothing to press.
 *
 * Deliberately NOT a route. A `/receipts/<n>/preview` page would fall outside
 * `RECEIPT_PATH` in `src/proxy.ts`, outside the PIN gate's membership test and
 * outside the receipt-link token's grant — three security-sensitive files for a
 * navigation affordance. An overlay introduces no URL, so the iframe reuses the
 * gate the PDF already passes (session cookie, PIN unlock cookie, or the
 * receipt grant cookie the proxy sets when it verifies an emailed link).
 *
 * ── The trap this is built around ──────────────────────────────────────────
 * The UA hides a closed popover with `[popover]:not(:popover-open) { display:
 * none }`, and ANY author `display` rule beats it. So the element carrying
 * `popover` carries NO class — everything lives on `.pdf-preview__panel`, one
 * level in. Same split as SortFilterMenu, BulkActionsMenu and DeleteItemButton.
 *
 * ── Why "Open in viewer" is conditional ────────────────────────────────────
 * Both QR routes serve a PDF *because* iOS/WKWebView ignores `window.print()`;
 * the native full-screen viewer's Share -> Print is the only way to print a
 * label from a phone, and an <iframe> has no such affordance. So the QR
 * surfaces keep a route to it. The receipt preview does not: there, navigating
 * the standalone window to the PDF re-creates precisely the dead end above, and
 * that page already offers Download separately.
 */

/** One overlay per page, so a fixed id rather than `useId` — it has to be an
 *  exact `popovertarget` reference AND an exact CSS selector, and useId's
 *  generated ids carry delimiters that are awkward in a selector. A page
 *  needing a SECOND PDF overlay would need its own id and its own rules; there
 *  is deliberately no class to inherit them from. */
export const PDF_PREVIEW_ID = "pdf-preview";

export function PdfPreviewOverlay({
  src,
  title,
  offerNativeViewer = false,
  onClose,
}: {
  /** The PDF to show, or null while closed. Set when the overlay OPENS, never
   *  at render — an eagerly rendered iframe would make every page load run a
   *  server-side pdf-lib render. */
  src: string | null;
  title: string;
  /** Offer "Open in viewer", which NAVIGATES to the PDF. True for the QR
   *  surfaces only — see the note above. */
  offerNativeViewer?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Drive the popover from `src`, so the caller owns ONE piece of state rather
  // than two that can disagree about whether the overlay is open.
  useEffect(() => {
    const el = ref.current;
    // jsdom implements no Popover API at all, so this guard is what keeps every
    // component test that renders this from throwing.
    if (!el || typeof el.showPopover !== "function") return;
    const open = el.matches(":popover-open");
    if (src && !open) el.showPopover();
    else if (!src && open) el.hidePopover();
  }, [src]);

  // The platform can close an `auto` popover without us — Escape, or the Back
  // button's own popovertargetaction — so the caller's state has to FOLLOW the
  // element rather than lead it. Without this, closing with Back would leave
  // `src` set, and re-opening the same PDF would set an unchanged value and do
  // nothing at all.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onToggle = (e: Event) => {
      if ((e as Event & { newState?: string }).newState === "closed") onClose();
    };
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, [onClose]);

  return (
    // NO className on this element. See the trap note above.
    <div id={PDF_PREVIEW_ID} popover="auto" ref={ref}>
      <div className="pdf-preview__panel">
        <div className="pdf-preview__bar">
          {/* popovertargetaction means this costs no handler and no state; the
              `toggle` listener above is what feeds the close back to the caller. */}
          <button
            type="button"
            className="btn btn-secondary"
            popoverTarget={PDF_PREVIEW_ID}
            popoverTargetAction="hide"
          >
            ← Back
          </button>
          <span className="pdf-preview__title truncate-inline">{title}</span>
          {src && (
            <>
              {offerNativeViewer && (
                <a className="btn btn-secondary" href={src} target="_blank" rel="noopener">
                  Open in viewer
                </a>
              )}
              {/* `download` as well as the stripped param: /i/<id>/qr/pdf is
                  inline unconditionally and has no param to strip. */}
              <a className="btn btn-secondary" href={downloadHref(src)} download>
                Download
              </a>
            </>
          )}
        </div>
        {src && <iframe className="pdf-preview__frame" src={src} title={title} />}
      </div>
    </div>
  );
}
