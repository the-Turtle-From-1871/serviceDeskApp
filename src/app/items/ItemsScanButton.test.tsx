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
const createScannedItemsAction = vi.fn();
vi.mock("@/app/admin/actions/scanned-items", () => ({
  createScannedItemsAction: (rows: unknown) => createScannedItemsAction(rows),
}));

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
      <button onClick={() => onDecode(["https://x.example/i/i1"])}>emit-sticker</button>
      {/* A Dell Express Service Code barcode. parseScan carries the raw
          11-digit value as `serial` and the 7-char Service Tag it converts to
          as `altSerial` — 17237164935 -> 7X2K9L3. Neither is in the book here. */}
      <button onClick={() => onDecode(["17237164935"])}>emit-express-unknown</button>
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
import { beep } from "@/lib/beep";

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
// The selection is now persisted to localStorage (see item-selection-store.ts),
// which — unlike the old useState — survives across tests in this file unless
// cleared: without this, a later test's fresh ItemSelectionProvider would
// rehydrate the previous test's selection instead of starting empty.
afterEach(() => window.localStorage.clear());
beforeEach(() => {
  vi.clearAllMocks();
  resolveScannedSerial.mockImplementation(async (sn: string) =>
    sn === "2TK94709FN" ? { ok: true, item: HP }
    : sn === "7X2K9L3" ? { ok: true, item: DELL_RETIRED }
    : { ok: false, code: "NOT_FOUND" });
  resolveScannedItemId.mockImplementation(async (id: string) =>
    id === "i1" ? { ok: true, item: HP } : { ok: false, code: "NOT_FOUND" });
  createScannedItemsAction.mockResolvedValue({
    ok: true,
    items: [{ id: "i3", make: "Acme", model: "Widget", serialNumber: "NOSUCH123", status: "ACTIVE" }],
    created: 1,
    existed: 0,
  });
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

  // A Dell label prints the Express Service Code and the Service Tag a
  // centimetre apart — the same value in base 10 and base 36. The TAG is what
  // Dell calls the serial and what the MDM export carries, so creating under
  // the raw express code would produce a row no import can ever match, and the
  // next import would create a SECOND row for the same laptop.
  it("creates an unknown express service code under its 7-character service tag", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-express-unknown" }));

    // The list shows the tag, not the 11-digit code that was scanned.
    expect(await screen.findByText("7X2K9L3")).toBeDefined();
    expect(screen.queryByText("17237164935")).toBeNull();
  });

  it("sends the service tag, not the express code, to the create action", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-express-unknown" }));
    await screen.findByText("7X2K9L3");
    await user.click(screen.getByRole("button", { name: /^Done/ }));

    await user.type(await screen.findByLabelText(/Make for 7X2K9L3/i), "Dell");
    await user.type(screen.getByLabelText(/Model for 7X2K9L3/i), "Latitude 5420");
    await user.click(screen.getByRole("button", { name: /^Create 1/ }));

    await waitFor(() => expect(createScannedItemsAction).toHaveBeenCalledWith([
      { serialNumber: "7X2K9L3", make: "Dell", model: "Latitude 5420" },
    ]));
  });

  // The lookup order is unchanged and must stay raw-first: preferring the
  // conversion when RESOLVING could rewrite a genuinely numeric serial into a
  // tag naming a different machine. Only the create path prefers the tag, and
  // only because the lookup already tried both and neither named an item.
  it("still looks up the raw value first, with the tag as the alternate", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-express-unknown" }));

    await waitFor(() => expect(resolveScannedSerial).toHaveBeenCalledWith("17237164935", "7X2K9L3"));
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

  describe("removing a mis-scanned row", () => {
    it("drops the row from the list and out of the Done selection", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText(/2TK94709FN/);
      await user.click(screen.getByRole("button", { name: "Remove 2TK94709FN" }));
      expect(screen.queryByText(/2TK94709FN/)).toBeNull();
      await user.click(screen.getByRole("button", { name: /^Done/ }));
      await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe(""));
    });

    it("lets the same label be scanned again afterward", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText(/2TK94709FN/);
      await user.click(screen.getByRole("button", { name: "Remove 2TK94709FN" }));
      resolveScannedSerial.mockClear();
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText(/2TK94709FN/);
      expect(resolveScannedSerial).toHaveBeenCalledTimes(1);
    });
  });

  describe("re-scanning an already-listed item", () => {
    it("shows an 'Already scanned' notice and does not add a second row", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText(/2TK94709FN/);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      expect(await screen.findByText(/^Already scanned$/i)).toBeDefined();
      expect(screen.getAllByText(/2TK94709FN/)).toHaveLength(1);
    });

    it("does not beep on every frame the code sits in view", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await screen.findByText(/2TK94709FN/);
      vi.mocked(beep).mockClear();
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      await user.click(screen.getByRole("button", { name: "emit-hp" }));
      // All four "frames" land well inside the 1.5s throttle window, so only
      // the first repeat should have produced a beep.
      expect(beep).toHaveBeenCalledTimes(1);
    });
  });

  describe("scanning our own printed sticker (/i/<id>)", () => {
    it("adds the item to the list on the very first scan", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      expect(await screen.findByText(/2TK94709FN/)).toBeDefined();
      expect(screen.queryByText(/^Already scanned$/i)).toBeNull();
    });

    it("commits the sticker-scanned item to the selection on Done", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      await screen.findByText(/2TK94709FN/);
      await user.click(screen.getByRole("button", { name: /^Done/ }));
      await waitFor(() => expect(screen.getByTestId("sel").textContent).toBe("i1"));
    });

    it("scanning the same sticker twice adds exactly one row and flags the repeat", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      await screen.findByText(/2TK94709FN/);
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      expect(await screen.findByText(/^Already scanned$/i)).toBeDefined();
      expect(screen.getAllByText(/2TK94709FN/)).toHaveLength(1);
    });

    it("lets the same sticker be scanned again after its row is removed", async () => {
      const user = userEvent.setup();
      setup();
      await open(user);
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      await screen.findByText(/2TK94709FN/);
      await user.click(screen.getByRole("button", { name: "Remove 2TK94709FN" }));
      expect(screen.queryByText(/2TK94709FN/)).toBeNull();
      resolveScannedItemId.mockClear();
      await user.click(screen.getByRole("button", { name: "emit-sticker" }));
      expect(await screen.findByText(/2TK94709FN/)).toBeDefined();
      expect(resolveScannedItemId).toHaveBeenCalledTimes(1);
    });
  });

  it("reports how many were created (and how many already existed) after the create form is submitted", async () => {
    const user = userEvent.setup();
    setup(true);
    await open(user);
    await user.click(screen.getByRole("button", { name: "emit-unknown" }));
    await screen.findByText(/^Not in the book$/i);
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    await user.type(await screen.findByLabelText(/Make for NOSUCH123/i), "Acme");
    await user.type(screen.getByLabelText(/Model for NOSUCH123/i), "Widget");
    await user.click(screen.getByRole("button", { name: /^Create 1/ }));
    expect(await screen.findByText(/1 item created\./i)).toBeDefined();
  });
});
