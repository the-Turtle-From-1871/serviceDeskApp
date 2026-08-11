// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createScannedItemsAction = vi.fn();
vi.mock("@/app/admin/actions/scanned-items", () => ({
  createScannedItemsAction: (rows: unknown) => createScannedItemsAction(rows),
}));

import { ScannedCreateForm } from "./ScannedCreateForm";

const entries = [
  { key: "sn:aaa1", kind: "new" as const, serial: "AAA1", label: { make: "HP", model: "HP ProBook 650 G5" } },
  { key: "sn:bbb2", kind: "new" as const, serial: "BBB2" },
];

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  createScannedItemsAction.mockResolvedValue({ ok: true, items: [], created: 2, existed: 0 });
});

describe("ScannedCreateForm", () => {
  it("prefills make and model from the label, and leaves the rest blank", () => {
    render(<ScannedCreateForm entries={entries} onCancel={() => {}} onCreated={() => {}} />);
    expect((screen.getByLabelText(/Make for AAA1/i) as HTMLInputElement).value).toBe("HP");
    expect((screen.getByLabelText(/Model for AAA1/i) as HTMLInputElement).value).toBe("HP ProBook 650 G5");
    expect((screen.getByLabelText(/Make for BBB2/i) as HTMLInputElement).value).toBe("");
  });

  it("sends one row per serial, serial taken from the label not the form", async () => {
    const user = userEvent.setup();
    render(<ScannedCreateForm entries={entries} onCancel={() => {}} onCreated={() => {}} />);
    await user.type(screen.getByLabelText(/Make for BBB2/i), "Dell");
    await user.type(screen.getByLabelText(/Model for BBB2/i), "Latitude");
    await user.click(screen.getByRole("button", { name: /^Create 2/ }));
    await waitFor(() => expect(createScannedItemsAction).toHaveBeenCalledWith([
      { serialNumber: "AAA1", make: "HP", model: "HP ProBook 650 G5" },
      { serialNumber: "BBB2", make: "Dell", model: "Latitude" },
    ]));
  });

  it("refuses to submit while a required field is empty", async () => {
    const user = userEvent.setup();
    render(<ScannedCreateForm entries={entries} onCancel={() => {}} onCreated={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Create 2/ }));
    expect(createScannedItemsAction).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("surfaces a server error without losing what was typed", async () => {
    createScannedItemsAction.mockResolvedValue({ error: "You do not have permission to create items." });
    const user = userEvent.setup();
    render(<ScannedCreateForm entries={[entries[0]]} onCancel={() => {}} onCreated={() => {}} />);
    await user.click(screen.getByRole("button", { name: /^Create 1/ }));
    expect(await screen.findByText(/do not have permission/i)).toBeDefined();
    expect((screen.getByLabelText(/Make for AAA1/i) as HTMLInputElement).value).toBe("HP");
  });
});
