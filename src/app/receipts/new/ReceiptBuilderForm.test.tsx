// @vitest-environment jsdom
//
// Reproduction for a desync found by a browser check: after a submit that fails
// SERVER-side validation, the sender's "This side is DCSIM" checkbox reports
// checked in the DOM (and posts senderIsDcsim=on) while React state — and the
// whole visible fieldset — still render as unchecked. On a hand receipt that
// files the sender as DCSIM when the operator can see they are not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const createReceiptAction = vi.fn();
vi.mock("@/app/actions/receipts", () => ({
  createReceiptAction: (prev: unknown, fd: FormData) => createReceiptAction(prev, fd),
}));
// jsdom has no canvas, and the pad is not what these tests are about.
vi.mock("@/components/SignaturePad", () => ({
  SignaturePad: ({ name }: { name: string }) => (
    <input type="hidden" name={name} value="data:image/png;base64,AAAA" readOnly />
  ),
}));
vi.mock("@/components/TechnicianSignatureField", () => ({
  TechnicianSignatureField: ({ name }: { name: string }) => (
    <input type="hidden" name={name} value="data:image/png;base64,AAAA" readOnly />
  ),
}));

import { ReceiptBuilderForm } from "./ReceiptBuilderForm";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // A server-side rejection — the trigger. Native validation blocks the submit
  // before this if any required field is empty, so every one is filled below.
  createReceiptAction.mockResolvedValue({ error: "Recipient signature is required." });
});

const LINES = [{ make: "Dell", model: "L5420", defaultQty: 1, items: [{ serialNumber: "SN1", itemId: "i1" }] }];

function renderForm(senderPrefill?: Parameters<typeof ReceiptBuilderForm>[0]["senderPrefill"]) {
  return render(
    <ReceiptBuilderForm itemIds={["i1"]} lines={LINES} senderPrefill={senderPrefill} signatures={[]} contacts={[]} />
  );
}

const party = (p: "Sender" | "Recipient") => within(screen.getByRole("group", { name: p }));
const dcsimBox = (p: "Sender" | "Recipient") => party(p).getByRole("checkbox") as HTMLInputElement;

// Queried BY LABEL, which only works because each label is tied to its input via
// htmlFor/id. Reaching for querySelector('[name=...]') here would pass against
// unlabeled fields and quietly lose the guarantee — see the a11y test below.
async function fillParty(user: ReturnType<typeof userEvent.setup>, p: "Sender" | "Recipient") {
  const q = party(p);
  const name = q.getByLabelText("Name") as HTMLInputElement;
  if (!name.value) await user.type(name, p === "Sender" ? "Jane Doe" : "Bob Smith");
  await user.type(q.getByLabelText("Rank"), "SGT");
  await user.type(q.getByLabelText("Unit"), "A Co");
  await user.type(q.getByLabelText("Contact number"), "5551112222");
  await user.type(q.getByLabelText("Email"), `${p.toLowerCase()}@unit.mil`);
}

describe("ReceiptBuilderForm — the DCSIM checkbox survives a failed submit", () => {
  it("keeps the sender's DCSIM checkbox unchecked after the server rejects", async () => {
    const user = userEvent.setup();
    // The load-bearing precondition: the sender STARTS DCSIM, because the items'
    // last receiver was one of our technicians. The operator then unchecks it.
    renderForm({ isDcsim: true, name: "SGT Tech" });

    expect(dcsimBox("Sender").checked).toBe(true);
    await user.click(dcsimBox("Sender"));
    expect(dcsimBox("Sender").checked).toBe(false);

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());
    await screen.findByRole("alert");

    // The bug: React's post-action form.reset() restores the checkbox to the
    // defaultChecked captured at mount (true), and because React state never
    // changed there is no re-render to correct it. The fieldset keeps rendering
    // unchecked while the DOM says otherwise.
    expect(dcsimBox("Sender").checked).toBe(false);
  });

  it("posts senderIsDcsim consistently with what the operator sees", async () => {
    const user = userEvent.setup();
    renderForm({ isDcsim: true, name: "SGT Tech" });

    await user.click(dcsimBox("Sender"));
    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalledTimes(1));
    await screen.findByRole("alert");

    // Resubmit after the failure — this is what actually files the receipt.
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalledTimes(2));

    const posted = createReceiptAction.mock.calls[1][1] as FormData;
    expect(posted.get("senderIsDcsim")).toBeNull(); // unchecked boxes post nothing
  });

  it("keeps a typed quantity after the server rejects", async () => {
    // qtyAuth/qtyIssued are uncontrolled (defaultValue), and React's reset fires
    // on ANY settled action — so a rejected submit may silently snap a typed
    // quantity back to the default. The operator fixes the real error, resubmits,
    // and the receipt is filed for the wrong count.
    const user = userEvent.setup();
    renderForm();

    const qty = () => screen.getByLabelText("Quantity authorized, Dell L5420") as HTMLInputElement;
    await user.clear(qty());
    await user.type(qty(), "3");
    expect(qty().value).toBe("3");

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());
    await screen.findByRole("alert");

    expect(qty().value).toBe("3");
  });

  // These were the only labels in the app not tied to their input — 13 other
  // forms do it — so a screen reader read eight fields on this page (four per
  // party) as unnamed edit boxes. getByLabelText resolves through htmlFor/id, so
  // it fails if the association is ever dropped again. That is the point.
  it("gives every field an accessible name, on both parties", () => {
    renderForm();

    for (const p of ["Sender", "Recipient"] as const) {
      for (const label of ["Name", "Rank", "Unit", "Contact number", "Email"]) {
        expect(party(p).getByLabelText(label)).toBeDefined();
      }
    }
    // The <th> orients a sighted user; the input itself needs its own name.
    expect(screen.getByLabelText("Quantity authorized, Dell L5420")).toBeDefined();
    expect(screen.getByLabelText("Quantity issued, Dell L5420")).toBeDefined();
  });

  it("leaves the receiver's checkbox alone (it never starts checked)", async () => {
    const user = userEvent.setup();
    renderForm({ isDcsim: true, name: "SGT Tech" });

    await user.click(dcsimBox("Sender"));
    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await screen.findByRole("alert");

    expect(dcsimBox("Recipient").checked).toBe(false);
  });
});
