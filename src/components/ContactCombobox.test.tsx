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
beforeEach(() => vi.resetAllMocks());

const ALVAREZ: ContactOption = {
  id: "c1",
  firstName: "Rosa",
  lastName: "Alvarez",
  rank: "SGT",
  email: "rosa.alvarez@example.mil",
  unit: "HHC",
} as ContactOption;

/** The real consumer (ReceiptBuilderForm) owns the text, so mirror that here —
 *  the combobox is controlled and cannot clear its own input. */
function Harness() {
  const [value, setValue] = useState("");
  return (
    <ContactCombobox name="receiverName" value={value} onValueChange={setValue} onPick={() => {}} />
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

    // THE ASSERTION THAT MATTERS. An empty box hiding the stale result is not
    // the same as the stale result being discarded: if it is merely hidden, it
    // comes straight back the moment there is any query again. Type one new
    // character and the abandoned "alv" contact must NOT be offered as a
    // suggestion for "z" — not even for the debounce window.
    searchContactsAction.mockReturnValue(new Promise<ContactOption[]>(() => {}));
    await userEvent.type(input, "z");
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
