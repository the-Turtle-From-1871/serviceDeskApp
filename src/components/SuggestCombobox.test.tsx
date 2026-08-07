// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuggestCombobox } from "./SuggestCombobox";

// jest-dom matchers are not used here, so assert on the DOM property directly
afterEach(cleanup);

const OPTIONS = ["Dell", "HP", "Panasonic", "Getac"];

describe("SuggestCombobox", () => {
  it("shows options on focus before anything is typed", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("filters case-insensitively on a substring", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    await userEvent.type(screen.getByRole("combobox"), "an");
    const shown = screen.getAllByRole("option").map((o) => o.textContent);
    expect(shown).toEqual(["Panasonic"]);
  });

  it("caps the list at maxVisible", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} maxVisible={2} />);
    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("picks the highlighted option with Enter", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await userEvent.type(input, "e");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(input.value).toBe("Dell");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("leaves freely typed text alone when nothing is highlighted", async () => {
    // The whole point: a value absent from the vocabulary must stay submittable,
    // because the CSV importer can introduce one the property book has not seen.
    // Test with a string that matches an option: list is open, but activeIndex is null.
    // Press Enter without ArrowDown — no pick should occur, typed text persists.
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    // Type "e" which matches "Dell" and "Getac"
    await userEvent.type(input, "e");
    // Verify the list opened with matches
    expect(screen.getAllByRole("option")).toHaveLength(2);
    // Press Enter WITHOUT navigation — no pick should happen, form should submit
    await userEvent.keyboard("{Enter}");
    // The typed text must persist, no pick occurred
    expect(input.value).toBe("e");

    // Also verify a wholly unmatched value stays submittable
    await userEvent.clear(input);
    await userEvent.type(input, "Toughbook");
    expect(input.value).toBe("Toughbook");
    // No matches, so list never opened
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("clicking an option fills the field", async () => {
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.click(screen.getByRole("option", { name: "Getac" }));
    expect(input.value).toBe("Getac");
  });

  it("Escape closes the list and drops the highlight", async () => {
    // Escape must clear `active`, not just hide the list: focus reopens it, and a
    // stale highlight would make the next Enter silently pick a dismissed option.
    render(<SuggestCombobox name="make" options={OPTIONS} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await userEvent.type(input, "e");
    await userEvent.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await userEvent.click(input);
    await userEvent.keyboard("{Enter}");
    expect(input.value).toBe("e");
  });

  it("posts through its own name and honours defaultValue", () => {
    render(<SuggestCombobox name="deviceCategory" options={OPTIONS} defaultValue="Laptop" />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("deviceCategory");
    expect(input.value).toBe("Laptop");
  });
});
