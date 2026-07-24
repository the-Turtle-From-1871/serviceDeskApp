import { describe, it, expect } from "vitest";
import { planImport, type ExistingItem } from "./import";
import type { RawRow } from "./csv";

const UNITS = new Map<string, string>([["DCSIM", "DCSIM"], ["487B", "487FA BATTERY B"]]);

const mk = (row: number, over: Partial<RawRow> = {}): RawRow => ({
  row, make: "M4", model: "Carbine", serialNumber: `S${row}`, deviceName: "Radio",
  homeUnit: "", notes: "", assignedUser: "", lastLogonUserPrincipalName: "",
  lastLogonDate: "", enrollmentDate: "", compliance: "", ...over,
});

const existing = (over: Partial<ExistingItem> = {}): ExistingItem => ({
  id: "id-1", status: "ACTIVE", make: "M4", model: "Carbine", deviceName: "Radio", currentUserEmail: null,
  lastLogonUserPrincipalName: null, lastLogonDate: null, enrollmentDate: null, compliance: null, ...over,
});

const map = (serial: string, item: ExistingItem) => new Map([[serial.toLowerCase(), item]]);

describe("planImport", () => {
  it("creates new, non-duplicate rows", () => {
    const { toCreate, toUpdate, skipped } = planImport([mk(1), mk(2)], new Map(), UNITS);
    expect(toCreate).toHaveLength(2);
    expect(toUpdate).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(toCreate[0]).toMatchObject({ make: "M4", model: "Carbine", serialNumber: "S1" });
  });

  it("updates deviceName on a serial match (logged) and leaves make/model", () => {
    const { toUpdate, unchanged } = planImport(
      [mk(1, { serialNumber: "A1", deviceName: "NewName" })],
      map("A1", existing({ id: "x", deviceName: "OldName" })),
      UNITS,
    );
    expect(unchanged).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0]).toMatchObject({ itemId: "x", serialNumber: "A1", makeModelMismatch: false });
    expect(toUpdate[0].data).toEqual({ deviceName: "NewName" });
    expect(toUpdate[0].loggedChanges).toEqual([{ field: "deviceName", from: "OldName", to: "NewName" }]);
  });

  it("updates assignedUser -> currentUserEmail (logged)", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", assignedUser: "jane@x.mil" })],
      map("A1", existing({ id: "x", currentUserEmail: null })),
      UNITS,
    );
    expect(toUpdate[0].data).toEqual({ currentUserEmail: "jane@x.mil" });
    expect(toUpdate[0].loggedChanges).toEqual([{ field: "currentUserEmail", from: null, to: "jane@x.mil" }]);
  });

  it("updates telemetry silently (no loggedChanges)", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", compliance: "Compliant", lastLogonDate: "2026-07-01" })],
      map("A1", existing({ id: "x" })),
      UNITS,
    );
    expect(toUpdate[0].data).toEqual({ compliance: "Compliant", lastLogonDate: "2026-07-01" });
    expect(toUpdate[0].loggedChanges).toEqual([]);
  });

  it("marks a fully-matching row unchanged", () => {
    const { toUpdate, unchanged } = planImport(
      [mk(1, { serialNumber: "A1", deviceName: "Radio" })],
      map("A1", existing({ id: "x", deviceName: "Radio" })),
      UNITS,
    );
    expect(toUpdate).toHaveLength(0);
    expect(unchanged).toEqual([{ row: 1, serialNumber: "A1", makeModelMismatch: false }]);
  });

  it("flags a make/model mismatch on a matched serial", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", make: "Dell", model: "5540", deviceName: "NewName" })],
      map("A1", existing({ id: "x", make: "M4", model: "Carbine", deviceName: "Old" })),
      UNITS,
    );
    expect(toUpdate[0].makeModelMismatch).toBe(true);
    expect(toUpdate[0].data).toEqual({ deviceName: "NewName" }); // make/model NOT written
  });

  it("blank assignedUser on a match leaves the stored value untouched", () => {
    const { toUpdate, unchanged } = planImport(
      [mk(1, { serialNumber: "A1", assignedUser: "" })],
      map("A1", existing({ id: "x", currentUserEmail: "keep@x.mil" })),
      UNITS,
    );
    expect(toUpdate).toHaveLength(0);
    expect(unchanged).toHaveLength(1);
  });

  it("never writes homeUnit/notes on a matched update, even when the CSV supplies them", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", deviceName: "NewName", homeUnit: "SomeUnit", notes: "some notes" })],
      map("A1", existing({ id: "x", deviceName: "Old" })),
      UNITS,
    );
    // deviceName changed -> it's an update; homeUnit/notes are ignored on a match.
    expect(toUpdate[0].data).toEqual({ deviceName: "NewName" });
    expect(toUpdate[0].data).not.toHaveProperty("homeUnit");
    expect(toUpdate[0].data).not.toHaveProperty("notes");
  });

  it("updates a RETIRED item's fields but emits no loggedChanges (no history row)", () => {
    const { toUpdate } = planImport(
      [mk(1, { serialNumber: "A1", deviceName: "NewName", assignedUser: "jane@x.mil", compliance: "Compliant" })],
      map("A1", existing({ id: "x", status: "RETIRED", deviceName: "Old", currentUserEmail: null })),
      UNITS,
    );
    expect(toUpdate).toHaveLength(1);
    // Fields still update (data carries every change)...
    expect(toUpdate[0].data).toEqual({ deviceName: "NewName", currentUserEmail: "jane@x.mil", compliance: "Compliant" });
    // ...but no ItemEdit history is written for a retired item.
    expect(toUpdate[0].loggedChanges).toEqual([]);
  });

  it("skips a new row missing make or model", () => {
    const { toCreate, skipped } = planImport([mk(1, { serialNumber: "N1", make: "" })], new Map(), UNITS);
    expect(toCreate).toHaveLength(0);
    expect(skipped).toEqual([{ row: 1, serialNumber: "N1", reason: "make and model are required for new items" }]);
  });

  it("skips a row with a blank serial", () => {
    const { skipped } = planImport([mk(1, { serialNumber: "" })], new Map(), UNITS);
    expect(skipped[0].reason).toMatch(/serial number is required/i);
  });

  it("treats serials differing only in case as the same device within a file", () => {
    const { toCreate, skipped } = planImport(
      [mk(1, { serialNumber: "AbC123" }), mk(2, { serialNumber: "abc123" })],
      new Map(), UNITS,
    );
    expect(toCreate).toHaveLength(1);
    expect(skipped).toEqual([{ row: 2, serialNumber: "abc123", reason: "duplicate in file" }]);
  });

  it("auto-fills homeUnit from the device name on create when blank", () => {
    const { toCreate, detected } = planImport(
      [mk(1, { deviceName: "HI-DCSIM-LT-001", homeUnit: "" })], new Map(), UNITS,
    );
    expect(toCreate[0].homeUnit).toBe("DCSIM");
    expect(detected).toBe(1);
  });

  it("reports unresolved device names on create", () => {
    const { unresolved } = planImport(
      [mk(1, { deviceName: "HI-XYZ-LT-001", homeUnit: "" })], new Map(), UNITS,
    );
    expect(unresolved).toEqual([{ row: 1, deviceName: "HI-XYZ-LT-001", segments: ["HI", "XYZ", "LT", "001"] }]);
  });
});
