// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ItemSelectionProvider, useItemSelection, type SelectedItem } from "./ItemSelection";

afterEach(cleanup);

const item = (id: string, status: SelectedItem["status"] = "ACTIVE"): SelectedItem => ({
  id, make: "HP", model: "ProBook", serialNumber: `SN${id}`, status,
});

function Probe() {
  const { selected, toggle, addMany, removeMany, clear } = useItemSelection();
  return (
    <div>
      <span data-testid="ids">{[...selected.keys()].join(",")}</span>
      <button onClick={() => toggle(item("a"))}>toggle-a</button>
      <button onClick={() => addMany([item("b"), item("c")])}>add-bc</button>
      <button onClick={() => addMany([item("r", "RETIRED")])}>add-retired</button>
      <button onClick={() => removeMany(["b"])}>remove-b</button>
      <button onClick={clear}>clear</button>
    </div>
  );
}

const ids = () => screen.getByTestId("ids").textContent;

describe("ItemSelection", () => {
  it("toggles one item on and off", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("toggle-a"));
    expect(ids()).toBe("a");
    await user.click(screen.getByText("toggle-a"));
    expect(ids()).toBe("");
  });

  it("addMany is additive and idempotent", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("toggle-a"));
    await user.click(screen.getByText("add-bc"));
    await user.click(screen.getByText("add-bc"));
    expect(ids()).toBe("a,b,c");
  });

  // Retired rows render no checkbox and are excluded from every bulk action
  // (selectableIds). A scanned batch must not smuggle one in.
  it("addMany refuses a RETIRED item", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("add-retired"));
    expect(ids()).toBe("");
  });

  it("removeMany and clear", async () => {
    const user = userEvent.setup();
    render(<ItemSelectionProvider><Probe /></ItemSelectionProvider>);
    await user.click(screen.getByText("add-bc"));
    await user.click(screen.getByText("remove-b"));
    expect(ids()).toBe("c");
    await user.click(screen.getByText("clear"));
    expect(ids()).toBe("");
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/ItemSelectionProvider/);
  });
});
