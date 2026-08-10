// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const resolveScannedSerial = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  resolveScannedSerial: (sn: string, alt?: string) => resolveScannedSerial(sn, alt),
}));

vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));

// The real component owns a camera and a wasm decoder, neither of which exists
// here. This stand-in emits one decoded FRAME per button, matching the idiom
// ReceiptBuilderForm.test.tsx already uses for the same component. A frame is
// an array because a service label is several codes at once.
vi.mock("@/components/QrScanner", () => ({
  SCAN_FORMATS: ["qr_code"],
  QrScanner: ({ onDecode, onClose, notice }: {
    onDecode: (t: string[]) => void;
    onClose: () => void;
    notice?: { kind: "ok" | "err"; text: string } | null;
  }) => (
    <div data-testid="scanner">
      <button type="button" onClick={() => onDecode(["https://x.example/i/abc123"])}>emit-sticker</button>
      <button type="button" onClick={() => onDecode(["5CD1234ABC"])}>emit-serial</button>
      <button type="button" onClick={() => onDecode(["17237164935"])}>emit-express</button>
      <button type="button" onClick={() => onDecode(["CN-0ABCDE-12345-ABC-1234-A00"])}>emit-ppid</button>
      {/* An HP service label as the camera actually sees it: the product-number
          barcode decodes alongside the QR, and the decoder puts it first. */}
      <button type="button" onClick={() => onDecode(["CN-0ABCDE-1", "SN:5CD1234ABC;PN:1AB23AV"])}>emit-hp-label</button>
      <button type="button" onClick={onClose}>emit-close</button>
      {notice && <p data-testid="scan-notice">{notice.text}</p>}
    </div>
  ),
}));

import { ItemsScanButton } from "./ItemsScanButton";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  resolveScannedSerial.mockResolvedValue({ ok: true, itemId: "i9" });
});

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^Scan$/i }));
  await screen.findByTestId("scanner");
};

describe("ItemsScanButton", () => {
  it("opens the item when our own sticker is scanned, without a round trip", async () => {
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-sticker" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/i/abc123"));
    expect(resolveScannedSerial).not.toHaveBeenCalled();
  });

  it("opens the item a scanned serial resolves to", async () => {
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-serial" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/i/i9"));
    expect(resolveScannedSerial).toHaveBeenCalledWith("5CD1234ABC", undefined);
  });

  // The create-from-search flow already lives on /items: the empty state offers
  // an admin "+ Create <serial> as a new item". Landing there reuses it rather
  // than growing a second create path with its own admin gate.
  it("lands on the filtered list when the serial is in no item", async () => {
    resolveScannedSerial.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-serial" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/items?q=5CD1234ABC"));
  });

  it("passes the converted express service code as the alternate", async () => {
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-express" }));

    await waitFor(() => expect(resolveScannedSerial).toHaveBeenCalledWith("17237164935", "7X2K9L3"));
  });

  // The decoder returns every code in the frame and decides their order, so the
  // one we can use is routinely not the first.
  it("uses the usable code in a frame that also holds unusable ones", async () => {
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp-label" }));

    await waitFor(() => expect(resolveScannedSerial).toHaveBeenCalledWith("5CD1234ABC", undefined));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/i/i9"));
  });

  // "Not an item code" alone is a dead end: the operator cannot report a label
  // nobody can read. The notice names what the camera actually decoded.
  it("names what it read when nothing in the frame parses", async () => {
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-ppid" }));

    const notice = await screen.findByTestId("scan-notice");
    expect(notice.textContent).toContain("CN-0ABCDE-12345-ABC-1234-A00");
  });

  it("keeps scanning after an unreadable code", async () => {
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-ppid" }));

    expect(await screen.findByTestId("scan-notice")).toBeDefined();
    expect(screen.getByTestId("scanner")).toBeDefined();
    expect(push).not.toHaveBeenCalled();
    expect(resolveScannedSerial).not.toHaveBeenCalled();
  });

  // A recoverable failure must not latch the sheet shut — the operator can try
  // the same label again.
  it("stays open and says so when the lookup fails", async () => {
    resolveScannedSerial.mockResolvedValue({ ok: false, code: "FAILED" });
    const user = userEvent.setup();
    render(<ItemsScanButton />);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-serial" }));

    expect(await screen.findByTestId("scan-notice")).toBeDefined();
    expect(push).not.toHaveBeenCalled();

    resolveScannedSerial.mockResolvedValue({ ok: true, itemId: "i9" });
    await user.click(screen.getByRole("button", { name: "emit-serial" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/i/i9"));
  });
});
