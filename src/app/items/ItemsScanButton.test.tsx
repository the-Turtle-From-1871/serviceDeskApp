// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemSelectionProvider, useItemSelection } from "@/components/ItemSelection";

const resolveScannedSerial = vi.fn();
const resolveScannedItemId = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  resolveScannedSerial: (sn: string, alt?: string) => resolveScannedSerial(sn, alt),
  resolveScannedItemId: (id: string) => resolveScannedItemId(id),
}));
vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));

vi.mock("@/components/QrScanner", () => ({
  SCAN_FORMATS: ["qr_code"],
  QrScanner: ({ onDecode, onClose, notice, children }: {
    onDecode: (t: string[]) => void; onClose: () => void;
    notice?: { kind: "ok" | "err"; text: string } | null; children?: React.ReactNode;
  }) => (
    <div data-testid="scanner">
      <button onClick={() => onDecode(["2TK94709FN, HP ProBook 650 G5, ProdID 5PF3"])}>emit-hp</button>
      <button onClick={() => onDecode(["7X2K9L3"])}>emit-dell</button>
      <button onClick={() => onDecode(["NOSUCH123"])}>emit-unknown</button>
      {/* Named literally "Done" to match the real QrScanner's footer button —
          this test asserts against /^Done/, which Task 7 later suffixes with
          a count. */}
      <button onClick={onClose}>Done</button>
      {notice && <p data-testid="scan-notice">{notice.text}</p>}
      {children}
    </div>
  ),
}));

import { ItemsScanButton } from "./ItemsScanButton";

const HP = { id: "i1", make: "HP", model: "HP ProBook 650 G5", serialNumber: "2TK94709FN", status: "ACTIVE" as const };
const DELL_RETIRED = { id: "i2", make: "Dell", model: "Latitude", serialNumber: "7X2K9L3", status: "RETIRED" as const };

function Selection() {
  const { selected } = useItemSelection();
  return <span data-testid="sel">{[...selected.keys()].join(",")}</span>;
}

const setup = (canCreate = true) =>
  render(<ItemSelectionProvider><ItemsScanButton canCreate={canCreate} /><Selection /></ItemSelectionProvider>);

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^Scan$/i }));
  await screen.findByTestId("scanner");
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  resolveScannedSerial.mockImplementation(async (sn: string) =>
    sn === "2TK94709FN" ? { ok: true, item: HP }
    : sn === "7X2K9L3" ? { ok: true, item: DELL_RETIRED }
    : { ok: false, code: "NOT_FOUND" });
});

describe("ItemsScanButton", () => {
  it("accumulates instead of navigating, and lists what it collected", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    expect(await screen.findByText(/2TK94709FN/)).toBeDefined();
    expect(screen.getByTestId("scanner")).toBeDefined(); // still open
  });

  it("does not add the same item twice", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    await waitFor(() => expect(resolveScannedSerial).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    expect(screen.getAllByText(/2TK94709FN/)).toHaveLength(1);
  });

  it("commits found items to the selection on Done", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-hp" }));
    await screen.findByText(/2TK94709FN/);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe("i1"));
  });

  it("lists a retired item but keeps it out of the selection", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-dell" }));
    // Anchored: the scan notice ALSO reads "...is retired — not added..." at
    // the same moment, and an unanchored match would hit both elements.
    expect(await screen.findByText(/^Retired$/i)).toBeDefined();
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe(""));
  });

  it("flags a serial that is in no item", async () => {
    const user = userEvent.setup();
    setup();
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    // Anchored for the same reason as above: the scan notice reads
    // "NOSUCH123 is not in the book", which an unanchored match also hits.
    expect(await screen.findByText(/^Not in the book$/i)).toBeDefined();
  });

  it("offers the create form on Done when a serial was unknown", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    // Anchored for the same reason as the earlier test in this file: the scan
    // notice also reads "...is not in the book" and an unanchored match hits both.
    await screen.findByText(/^Not in the book$/i);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    expect(await screen.findByRole("button", { name: /^Create 1/ })).toBeDefined();
  });

  it("shows no create path without MANAGE_ITEMS", async () => {
    const user = userEvent.setup();
    setup(false);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    // Anchored for the same reason as the earlier test in this file: the scan
    // notice also reads "...is not in the book" and an unanchored match hits both.
    await screen.findByText(/^Not in the book$/i);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    expect(screen.queryByRole("button", { name: /^Create/ })).toBeNull();
  });
});
