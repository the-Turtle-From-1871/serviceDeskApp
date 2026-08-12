// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PdfPreviewOverlay } from "./PdfPreviewOverlay";

/**
 * READ THIS BEFORE ADDING A TEST HERE. jsdom implements no Popover API —
 * `showPopover` is undefined and `:popover-open` never matches — while it DOES
 * apply the UA's `[popover]:not(:popover-open) { display: none }`. So the panel
 * is permanently hidden here: role queries into it need `hidden: true`, and
 * nothing below is evidence that the overlay opens, that Escape closes it, that
 * the bar clears the safe-area inset, or that WKWebView renders the PDF. All of
 * that is browser-only — and the iframe's PDF fidelity is iPhone-only.
 */

// This suite runs without vitest `globals: true`, so @testing-library/react's
// auto-cleanup never registers. Mirrors ItemSelectTable.test.tsx.
afterEach(cleanup);

const hidden = { hidden: true } as const;

test("the popover element carries NO class — a layout class would render it while closed", () => {
  const { container } = render(
    <PdfPreviewOverlay src={null} title="HR-000001" onClose={vi.fn()} />,
  );
  const popover = container.querySelector("[popover]");
  expect(popover).not.toBeNull();
  expect(popover!.getAttribute("popover")).toBe("auto");
  expect(popover!.getAttribute("class")).toBeNull();
  // The layout lives on an inner wrapper instead.
  expect(popover!.querySelector(":scope > .pdf-preview__panel")).not.toBeNull();
});

/**
 * The iframe must not exist until the overlay opens. Rendering it eagerly would
 * make every receipt page load run a server-side pdf-lib render of the whole DA
 * 2062, and every /items load build a QR sheet.
 */
test("renders no iframe while closed", () => {
  const { container } = render(
    <PdfPreviewOverlay src={null} title="HR-000001" onClose={vi.fn()} />,
  );
  expect(container.querySelector("iframe")).toBeNull();
});

test("renders the iframe once a src is supplied", () => {
  const { container } = render(
    <PdfPreviewOverlay src="/receipts/HR-000001/pdf?preview=1" title="HR-000001" onClose={vi.fn()} />,
  );
  const frame = container.querySelector("iframe");
  expect(frame).not.toBeNull();
  expect(frame!.getAttribute("src")).toBe("/receipts/HR-000001/pdf?preview=1");
});

test("Back hides the popover by id, with no handler of its own", () => {
  render(<PdfPreviewOverlay src={null} title="HR-000001" onClose={vi.fn()} />);
  const back = screen.getByRole("button", { name: /Back/, ...hidden });
  expect(back.getAttribute("popovertarget")).toBe("pdf-preview");
  expect(back.getAttribute("popovertargetaction")).toBe("hide");
  // A bare <button> defaults to type="submit"; this one must never submit.
  expect(back.getAttribute("type")).toBe("button");
});

test("Download points at the attachment form of the same URL", () => {
  render(
    <PdfPreviewOverlay src="/receipts/HR-000001/pdf?preview=1" title="HR-000001" onClose={vi.fn()} />,
  );
  const link = screen.getByRole("link", { name: /Download/, ...hidden });
  expect(link.getAttribute("href")).toBe("/receipts/HR-000001/pdf");
  // Belt and braces for /i/<id>/qr/pdf, which is inline unconditionally and has
  // no preview param to drop.
  expect(link.hasAttribute("download")).toBe(true);
});

/**
 * THE PER-SURFACE SPLIT. Both QR routes serve a PDF *because* iOS ignores
 * window.print() — the native viewer's Share -> Print is their whole purpose —
 * so they keep a route to it. The receipt preview deliberately does NOT: there,
 * navigating the standalone window to the PDF re-creates the exact dead end
 * this component exists to fix, and the receipt page already offers Download.
 */
test("the receipt preview offers no route to the native viewer", () => {
  render(
    <PdfPreviewOverlay src="/receipts/HR-000001/pdf?preview=1" title="HR-000001" onClose={vi.fn()} />,
  );
  expect(screen.queryByRole("link", { name: /Open in viewer/, ...hidden })).toBeNull();
});

test("a QR surface does, pointing at the inline URL", () => {
  render(
    <PdfPreviewOverlay
      src="/i/abc123/qr/pdf"
      title="QR label"
      offerNativeViewer
      onClose={vi.fn()}
    />,
  );
  const link = screen.getByRole("link", { name: /Open in viewer/, ...hidden });
  expect(link.getAttribute("href")).toBe("/i/abc123/qr/pdf");
});
