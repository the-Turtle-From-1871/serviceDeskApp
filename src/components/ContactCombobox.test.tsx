// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

const searchContactsAction = vi.fn();
vi.mock("@/app/actions/contacts", () => ({
  searchContactsAction: (q: string) => searchContactsAction(q),
}));

import { ContactCombobox } from "./ContactCombobox";
import type { ContactOption } from "@/modules/contacts/contact-match";

afterEach(cleanup);
// resetAllMocks, not clearAllMocks: `clear` wipes call records but LEAVES the
// implementation, so the never-auto-resolving promise one test installs would
// leak into every test appended after it and hang on findByRole.
beforeEach(() => {
  vi.resetAllMocks();
  // Baseline implementation. resetAllMocks drops implementations as well as
  // call records, so without this any call past a test's `...Once` values
  // returns undefined, `items: undefined` lands in state, and the component
  // throws a TypeError instead of failing an assertion readably.
  searchContactsAction.mockResolvedValue([]);
});

const ALVAREZ: ContactOption = {
  id: "c1",
  firstName: "Rosa",
  lastName: "Alvarez",
  rank: "SGT",
  email: "rosa.alvarez@example.mil",
  unit: "HHC",
} as ContactOption;

/** Mirrors the real consumer: the combobox is controlled, so the parent owns the
 *  text, and ReceiptBuilderForm's onPick REWRITES it to the chosen contact's
 *  name. That rewrite is load-bearing for behaviour under test — a no-op onPick
 *  leaves the query unchanged after a pick and quietly hides anything that
 *  depends on the post-pick refetch. */
function Harness() {
  const [value, setValue] = useState("");
  return (
    <ContactCombobox
      name="receiverName"
      value={value}
      onValueChange={setValue}
      onPick={(c) => setValue(`${c.firstName} ${c.lastName}`)}
    />
  );
}

describe("ContactCombobox", () => {
  it("lists matches for the typed query", async () => {
    searchContactsAction.mockResolvedValue([ALVAREZ]);
    render(<Harness />);

    await userEvent.type(screen.getByRole("combobox"), "alv");
    expect(await screen.findByRole("option", { name: /Alvarez/ })).toBeDefined();
  });

  it("shows nothing once the query is cleared, and fires no search for empty text", async () => {
    searchContactsAction.mockResolvedValue([ALVAREZ]);
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await userEvent.type(input, "alv");
    expect(await screen.findByRole("option", { name: /Alvarez/ })).toBeDefined();

    searchContactsAction.mockClear();
    await userEvent.clear(input);

    // Derived from the CURRENT query, so the stale match disappears with the
    // text rather than waiting on a state reset.
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(screen.getByRole("combobox").getAttribute("aria-expanded")).toBe("false");
    expect(searchContactsAction).not.toHaveBeenCalled();
  });

  it("does not surface a late response for text the user already deleted", async () => {
    // The response lands AFTER the input is cleared — the regression the derived
    // list closes. Previously it repopulated state and listed a suggestion for
    // an empty box.
    let release!: (v: ContactOption[]) => void;
    searchContactsAction.mockReturnValue(
      new Promise<ContactOption[]>((resolve) => {
        release = resolve;
      }),
    );
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await userEvent.type(input, "alv");
    // The request must actually be in flight, or this proves nothing.
    await waitFor(() => expect(searchContactsAction).toHaveBeenCalledWith("alv"));
    await userEvent.clear(input);

    // Flush the resolution and its re-render BEFORE asserting. A bare
    // `waitFor(() => expect(...).toBeNull())` would pass on its first poll
    // simply because the update had not landed yet, and so would pass against
    // the very code this guards.
    await act(async () => {
      release([ALVAREZ]);
    });

    expect(screen.queryByRole("option")).toBeNull();

    searchContactsAction.mockReturnValue(new Promise<ContactOption[]>(() => {}));
    await userEvent.type(input, "z");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("does not offer the previous query's contacts while a new query is pending", async () => {
    // The other half of the rule, and the one an empty-box check cannot reach:
    // "alv" has ANSWERED and is on screen. Typing another character makes those
    // results stale immediately — they describe "alv", not "alve" — so they must
    // disappear at the keystroke, not linger through the 200ms debounce and the
    // round-trip while the box reads "alve".
    searchContactsAction
      .mockResolvedValueOnce([ALVAREZ])
      .mockReturnValue(new Promise<ContactOption[]>(() => {})); // "alve" — pending
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await userEvent.type(input, "alv");
    expect(await screen.findByRole("option", { name: /Alvarez/ })).toBeDefined();

    await userEvent.type(input, "e");
    expect((input as HTMLInputElement).value).toBe("alve");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("closes the list on pick and does not reopen it with the picked contact", async () => {
    searchContactsAction.mockResolvedValue([ALVAREZ]);
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await userEvent.type(input, "alv");
    await userEvent.click(await screen.findByRole("option", { name: /Alvarez/ }));

    // onPick rewrote the field to the full name, so the query changed and the
    // suggestions no longer belong to it. Nothing should be listed until the
    // search for the NEW text lands.
    expect((input as HTMLInputElement).value).toBe("Rosa Alvarez");
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("keeps a typed name submittable — Enter is not swallowed with no highlight", async () => {
    searchContactsAction.mockResolvedValue([ALVAREZ]);
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
      </form>,
    );

    const input = screen.getByRole("combobox");
    await userEvent.type(input, "alv");
    expect(await screen.findByRole("option", { name: /Alvarez/ })).toBeDefined();

    // No ArrowDown, so nothing is highlighted: Enter must submit what was typed
    // rather than picking the first suggestion.
    await userEvent.type(input, "{Enter}");
    expect(onSubmit).toHaveBeenCalled();
  });
});
