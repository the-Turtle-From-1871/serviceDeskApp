// @vitest-environment jsdom
//
// The first component test in this repo. Everything else runs under `node`
// (see vitest.config.ts) — that is still right for the service and action
// suites, which want the speed and touch no DOM. But it meant NO component was
// ever rendered by anything: a bug where one contact's phone number was carried
// onto the next contact — and would have printed on a signed DA 2062 — passed
// all 338 tests and seven code reviews before a whole-branch review caught it by
// reading. The tests below are that bug, and they fail against the code as it
// was written.
//
// Server actions are mocked, as they are in this repo's other action tests
// (see src/app/actions/search.test.ts): useActionState only needs an async
// function, so nothing here touches Prisma or the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createContactAction = vi.fn();
vi.mock("@/app/admin/actions/contacts", () => ({
  createContactAction: (prev: unknown, fd: FormData) => createContactAction(prev, fd),
  updateContactAction: vi.fn(),
  deleteContactAction: vi.fn(),
}));

import { ContactBookSection } from "./ContactBookSection";

// RTL's auto-cleanup only registers itself when Vitest `globals` are on; this
// config keeps explicit imports, so unmount between tests by hand.
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  createContactAction.mockResolvedValue({ ok: true });
});

const phone = () => screen.getByLabelText("Contact number") as HTMLInputElement;

async function addContact(
  user: ReturnType<typeof userEvent.setup>,
  { first, last, email, tel }: { first: string; last: string; email: string; tel?: string }
) {
  await user.type(screen.getByLabelText("First name"), first);
  await user.type(screen.getByLabelText("Last name"), last);
  await user.type(screen.getByLabelText("Email"), email);
  if (tel) await user.type(phone(), tel);
  await user.click(screen.getByRole("button", { name: "Add contact" }));
}

describe("ContactBookSection — the add form clears between contacts", () => {
  it("clears the phone after a successful add", async () => {
    const user = userEvent.setup();
    render(<ContactBookSection contacts={[]} />);

    await addContact(user, { first: "Jane", last: "Doe", email: "jane@unit.mil", tel: "5551112222" });
    await waitFor(() => expect(createContactAction).toHaveBeenCalled());

    // The regression: PhoneInput renders `value={...}`, so React treats it as
    // controlled and its automatic post-action reset of UNCONTROLLED fields
    // skips it. Every other field here clears on its own; this one did not.
    await waitFor(() => expect(phone().value).toBe(""));
  });

  it("does not carry one contact's phone onto the next", async () => {
    const user = userEvent.setup();
    render(<ContactBookSection contacts={[]} />);

    await addContact(user, { first: "Jane", last: "Doe", email: "jane@unit.mil", tel: "5551112222" });
    await waitFor(() => expect(createContactAction).toHaveBeenCalledTimes(1));

    // Bob gets no phone typed. Whatever the form posts for him must not be Jane's.
    await waitFor(() => expect(phone().value).toBe(""));
    await addContact(user, { first: "Bob", last: "Smith", email: "bob@unit.mil" });
    await waitFor(() => expect(createContactAction).toHaveBeenCalledTimes(2));

    const posted = createContactAction.mock.calls[1][1] as FormData;
    expect(posted.get("firstName")).toBe("Bob");
    expect(posted.get("contactNumber")).not.toBe("(555)-111-2222");
    expect(posted.get("contactNumber")).toBe("");
  });

  it("clears the phone after a FAILED add too", async () => {
    // React gates its form reset on the action's promise RESOLVING, not on what
    // it resolved to — so a duplicate-email error blanks the five uncontrolled
    // fields anyway. If the phone alone survived, the admin would abandon this
    // contact, type the next one, and save them under this one's number.
    const user = userEvent.setup();
    createContactAction.mockResolvedValue({ error: "A contact with that email already exists." });
    render(<ContactBookSection contacts={[]} />);

    await addContact(user, { first: "Bob", last: "Smith", email: "taken@unit.mil", tel: "5553334444" });
    await screen.findByRole("alert");

    await waitFor(() => expect(phone().value).toBe(""));
  });

  it("formats a typed phone number as (xxx)-xxx-xxxx", async () => {
    const user = userEvent.setup();
    render(<ContactBookSection contacts={[]} />);

    await user.type(phone(), "5551112222");
    expect(phone().value).toBe("(555)-111-2222");
  });
});
