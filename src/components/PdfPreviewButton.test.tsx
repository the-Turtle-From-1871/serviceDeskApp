// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PdfPreviewButton } from "./PdfPreviewButton";

/**
 * jsdom implements no Popover API, so the overlay never actually opens here —
 * `showPopover` is undefined and the component guards on it. What IS testable
 * is the branch: whether the click is left alone or intercepted, and whether
 * the iframe gets mounted. Opening, focus and dismissal are browser-only.
 */

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hidden = { hidden: true } as const;
const asInstalledApp = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
const asBrowserTab = () => vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));

/**
 * The server-rendered output must be byte-identical to the plain anchor this
 * replaces, so a browser tab keeps today's behaviour exactly and a tap landing
 * before hydration is no worse than it is now.
 */
test("renders the same anchor a browser tab has always had", () => {
  asBrowserTab();
  render(
    <PdfPreviewButton
      href="/receipts/HR-000001/pdf?preview=1"
      title="HR-000001"
      label="Preview PDF"
    />,
  );
  const link = screen.getByRole("link", { name: "Preview PDF" });
  expect(link.getAttribute("href")).toBe("/receipts/HR-000001/pdf?preview=1");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.getAttribute("class")).toBe("btn btn-secondary");
});

test("a browser tab's click is left entirely alone", () => {
  asBrowserTab();
  const { container } = render(
    <PdfPreviewButton href="/receipts/HR-000001/pdf?preview=1" title="HR-000001" label="Preview PDF" />,
  );
  const clicked = fireEvent.click(screen.getByRole("link", { name: "Preview PDF" }));
  // fireEvent returns false when a handler called preventDefault.
  expect(clicked).toBe(true);
  expect(container.querySelector("iframe")).toBeNull();
});

test("the installed app's click is intercepted and shows the PDF in the overlay", () => {
  asInstalledApp();
  const { container } = render(
    <PdfPreviewButton href="/receipts/HR-000001/pdf?preview=1" title="HR-000001" label="Preview PDF" />,
  );
  const clicked = fireEvent.click(screen.getByRole("link", { name: "Preview PDF" }));
  expect(clicked).toBe(false);
  expect(container.querySelector("iframe")!.getAttribute("src"))
    .toBe("/receipts/HR-000001/pdf?preview=1");
});

test("passes the class and rel through unchanged, for the item QR link", () => {
  asBrowserTab();
  render(
    <PdfPreviewButton
      href="/i/abc123/qr/pdf"
      title="QR label"
      label="Print QR"
      className="btn btn-primary no-print"
      rel="noopener"
      offerNativeViewer
    />,
  );
  const link = screen.getByRole("link", { name: "Print QR" });
  expect(link.getAttribute("class")).toBe("btn btn-primary no-print");
  expect(link.getAttribute("rel")).toBe("noopener");
});

test("only a QR surface offers the native viewer once open", () => {
  asInstalledApp();
  render(
    <PdfPreviewButton
      href="/i/abc123/qr/pdf" title="QR label" label="Print QR" offerNativeViewer
    />,
  );
  fireEvent.click(screen.getByRole("link", { name: "Print QR" }));
  expect(screen.getByRole("link", { name: /Open in viewer/, ...hidden })).toBeTruthy();
});
