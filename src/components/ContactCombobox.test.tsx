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

  it("does not let a search still in flight repopulate the list after a pick", async () => {
    // Picking clears the fetched contacts so the address book's PII does not
    // linger in client state. That clear only sticks if the request in flight at
    // the moment of the pick is invalidated too — otherwise it resolves a beat
    // later, passes the race guard, and writes every matched person straight
    // back in. Assert through the UI: reopening must offer nothing.
    // Getting a request in flight WHILE options are on screen takes a query that
    // leaves and returns: "alv" answers and is displayed, "alve" never answers
    // (so the displayed "alv" results stand), and deleting back to "alv" starts a
    // fresh request for a query whose old results are still showing. The pick
    // then happens with that third request outstanding.
    let release!: (v: ContactOption[]) => void;
    searchContactsAction
      .mockResolvedValueOnce([ALVAREZ]) // "alv"
      .mockReturnValueOnce(new Promise<ContactOption[]>(() => {})) // "alve" — never lands
      .mockReturnValueOnce(
        new Promise<ContactOption[]>((resolve) => {
          release = resolve;
        }), // "alv" again — still in flight at pick time
      );
    render(<Harness />);

    const input = screen.getByRole("combobox");
    // Each step waits for its request to actually dispatch. Without that the
    // 200ms debounce cancels the middle one, the mocks shift by a position, and
    // the test silently exercises a different sequence than it reads as.
    await userEvent.type(input, "alv");
    await waitFor(() => expect(searchContactsAction).toHaveBeenCalledTimes(1));
    await screen.findByRole("option", { name: /Alvarez/ });

    await userEvent.type(input, "e");
    await waitFor(() => expect(searchContactsAction).toHaveBeenCalledTimes(2));

    await userEvent.type(input, "{Backspace}");
    await waitFor(() => expect(searchContactsAction).toHaveBeenCalledTimes(3));
    const option = await screen.findByRole("option", { name: /Alvarez/ });

    await userEvent.click(option);

    // The third request lands after the pick. Without invalidating it, this
    // writes the contact book back into state.
    await act(async () => {
      release([ALVAREZ]);
    });

    // Blur first: the option list preventDefaults mousedown so the input keeps
    // focus through a pick, and clicking an already-focused element fires no
    // focus event — so without this the list never reopens and the assertion
    // below passes for the wrong reason.
    await userEvent.tab();
    await userEvent.click(input); // refocus -> open
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
