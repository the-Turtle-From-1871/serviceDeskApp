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
// jsdom has no canvas. These stand-ins mirror the real components' report paths
// (SignaturePad.tsx:21,28 and TechnicianSignatureField.tsx:50-51) so a test can
// drive signing without one — and reflect the value into the hidden input so a
// test can prove the ink is DISCARDED on a list change, not just that a notice
// shows.
//
// The hidden input intentionally carries NEITHER `value` NOR `defaultValue`:
// for `type="hidden"` there is no separate dirty-value store (the "value" IDL
// attribute for hidden inputs is a *direct alias* for the "value" CONTENT
// attribute — see https://html.spec.whatwg.org/#dom-input-value-default). A
// `defaultValue` prop would make React re-apply that attribute on every
// unrelated commit (any re-render, not just a `key` remount), stomping the
// value we just set. With no value/defaultValue prop at all, React never
// touches this element after it mounts, so an imperative `.value =` sticks
// across ordinary re-renders — and a `key` remount still creates a brand-new
// element, whose native default value is "", so the reset-on-remount behavior
// this test suite depends on is unaffected.
vi.mock("@/components/SignaturePad", () => ({
  SignaturePad: ({ name, onChange }: { name: string; onChange?: (dataUrl: string) => void }) => (
    <>
      <input type="hidden" name={name} />
      <button type="button" onClick={() => {
        (document.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = "data:image/png;base64,DRAWN";
        onChange?.("data:image/png;base64,DRAWN");
      }}>simulate-sign</button>
    </>
  ),
}));
vi.mock("@/components/TechnicianSignatureField", () => ({
  TechnicianSignatureField: ({ name, onChange, onPickedChange }: { name: string; onChange?: (v: string) => void; onPickedChange?: (id: string | null) => void }) => (
    <>
      <input type="hidden" name={name} />
      {/* DCSIM recipient DRAWS (the common case: signatures=[] for non-admins) */}
      <button type="button" onClick={() => {
        (document.querySelector(`input[name="${name}"]`) as HTMLInputElement).value = "data:image/png;base64,DRAWN";
        onChange?.("data:image/png;base64,DRAWN");
      }}>dcsim-draw</button>
      {/* DCSIM recipient PICKS a saved signature: reports both signals, like the real one */}
      <button type="button" onClick={() => { onPickedChange?.("sig-1"); onChange?.("data:image/png;base64,PICKED"); }}>dcsim-pick</button>
    </>
  ),
}));

const lookupScannedItem = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  lookupScannedItem: (id: string) => lookupScannedItem(id),
}));
// The camera is not what these tests are about. This stands in for it: a button
// per fixture that emits one decoded string. `notice` IS rendered here — the
// real QrScanner (src/components/QrScanner.tsx) shows it as feedback over the
// video sheet, and the refusal tests below assert their error text while the
// sheet is open, so the mock must surface it the same way the real one does.
vi.mock("@/components/QrScanner", () => ({
  QrScanner: ({ onDecode, onClose, notice }: { onDecode: (t: string) => void; onClose: () => void; notice?: { kind: "ok" | "err"; text: string } | null }) => (
    <div>
      <button type="button" onClick={() => onDecode("https://x.example/i/i2")}>emit-i2</button>
      <button type="button" onClick={() => onDecode("https://x.example/i/i3")}>emit-i3</button>
      <button type="button" onClick={() => onDecode("https://x.example/i/i1")}>emit-i1</button>
      <button type="button" onClick={() => onDecode("WIFI:S:Guest;;")}>emit-junk</button>
      <button type="button" onClick={onClose}>emit-close</button>
      {notice && <p data-testid="scan-notice">{notice.text}</p>}
    </div>
  ),
}));
vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));

import { ReceiptBuilderForm } from "./ReceiptBuilderForm";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // A server-side rejection — the trigger. Native validation blocks the submit
  // before this if any required field is empty, so every one is filled below.
  createReceiptAction.mockResolvedValue({ error: "Recipient signature is required." });
});

const ITEMS = [
  { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
];

function renderForm(
  senderPrefill?: Parameters<typeof ReceiptBuilderForm>[0]["senderPrefill"],
  initialItems: Parameters<typeof ReceiptBuilderForm>[0]["initialItems"] = ITEMS,
) {
  return render(
    <ReceiptBuilderForm
      initialItems={initialItems}
      senderPrefill={senderPrefill}
      signatures={[]}
      contacts={[]}
    />
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
    // qtyAuth/qtyIssued are controlled via the lifted `qtyEdits` state, and
    // React's reset fires on ANY settled action — so a rejected submit may
    // silently snap a typed quantity back to the default if that state weren't
    // kept in sync. This verifies a typed qty survives a rejected submit: the
    // operator fixes the real error, resubmits, and the receipt is filed for
    // the count they actually typed.
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

describe("ReceiptBuilderForm — the item list is the form's own state", () => {
  const TWO = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "HP", model: "G8", serialNumber: "SN2", holderName: null },
  ];

  it("posts one itemId per item", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);
    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1", "i2"]);
  });

  it("removes an item and stops posting it", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    expect(screen.queryByText("SN2")).toBeNull();

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1"]);
  });

  // A receipt with no items is not a receipt, and an empty `?items=` would
  // notFound() on reload (receipts/new/page.tsx:15).
  it("will not let the last item be removed", () => {
    renderForm();
    expect((screen.getByRole("button", { name: /Remove Dell L5420, serial SN1/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Keeps the URL recoverable after an iOS tab eviction. replaceState, not
  // pushState: a scan is not a history entry.
  it("keeps ?items= in step with the list", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(window.history, "replaceState");
    renderForm(undefined, TWO);

    await waitFor(() => expect(spy).toHaveBeenCalledWith(null, "", "?items=i1,i2"));

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(null, "", "?items=i1"));
    spy.mockRestore();
  });
});

describe("ReceiptBuilderForm — quantities track the item count", () => {
  const auth = () => screen.getByLabelText("Quantity authorized, Dell L5420") as HTMLInputElement;
  const issued = () => screen.getByLabelText("Quantity issued, Dell L5420") as HTMLInputElement;

  const TWO_SAME = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "Dell", model: "L5420", serialNumber: "SN2", holderName: null },
  ];

  // The defect: QtyInput used to seed its state once from defaultQty. With a
  // growable list that leaves the line holding two serials while Issued still
  // reads 1 — a custody document filed for the wrong count.
  it("shows the item count for an untouched line", () => {
    renderForm(undefined, TWO_SAME);
    expect(auth().value).toBe("2");
    expect(issued().value).toBe("2");
  });

  it("drops to the new count when an item is removed", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);
    expect(issued().value).toBe("2");

    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN2/i }));
    expect(issued().value).toBe("1");
  });

  // An explicitly typed quantity is the operator's, and outranks the count.
  it("leaves an edited quantity alone when the list changes", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);

    await user.clear(auth());
    await user.type(auth(), "5");
    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN2/i }));

    expect(auth().value).toBe("5");
    expect(issued().value).toBe("1"); // untouched, so it still tracks
  });
});

describe("ReceiptBuilderForm — service flags survive a sibling's removal", () => {
  const TWO_SAME = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "Dell", model: "L5420", serialNumber: "SN2", holderName: null },
  ];

  // Guards Task 4's per-item row key. If a future change keys rows on the line's
  // first itemId again, removing SN1 remounts SN2's row and this goes red.
  // NOTE: getAllByRole("checkbox") also returns the two party DCSIM boxes, so
  // scope to the Needs-service accessible name — do not index a mixed list.
  it("keeps the surviving item's flag when the first item of its line is removed", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);

    const flags = () => screen.getAllByRole("checkbox", { name: /Needs service/i });
    expect(flags()).toHaveLength(2);
    await user.click(flags()[1]); // flag SN2 (the second item)
    expect((flags()[1] as HTMLInputElement).checked).toBe(true);

    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN1/i }));

    const left = flags();
    expect(left).toHaveLength(1);
    expect((left[0] as HTMLInputElement).checked).toBe(true);
  });

  it("posts the flag under the surviving item's id", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO_SAME);

    await user.click(screen.getAllByRole("checkbox", { name: /Needs service/i })[1]);
    await user.click(screen.getByRole("button", { name: /Remove Dell L5420, serial SN1/i }));
    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.get("service[i2][needs]")).toBe("on");
    expect(posted.get("service[i1][needs]")).toBeNull();
  });
});

describe("ReceiptBuilderForm — a signature attests to a specific item list", () => {
  const TWO = [
    { itemId: "i1", make: "Dell", model: "L5420", serialNumber: "SN1", holderName: null },
    { itemId: "i2", make: "HP", model: "G8", serialNumber: "SN2", holderName: null },
  ];
  const sig = (c: HTMLElement) => c.querySelector('input[name="receiverSignature"]') as HTMLInputElement;

  // Today the list is frozen at mount, so signing last is inherently safe. Once
  // a scan can grow it, an operator can have the recipient sign and THEN add
  // laptops — filing a receipt with a signature over a list the signer never
  // saw. So a list change invalidates the ink.
  it("clears the DRAWN signature (ink, not just the notice) when the list changes", async () => {
    const user = userEvent.setup();
    const { container } = renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: "simulate-sign" }));
    expect(sig(container).value).toBe("data:image/png;base64,DRAWN");
    expect(screen.queryByText(/please sign again/i)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));

    // The ink is GONE — proves key={itemsKey} remounted the pad. Deleting that
    // key leaves this line red while the notice still appears; that is the whole
    // point of asserting the value, not just the message.
    expect(sig(container).value).toBe("");
    expect(await screen.findByText(/Items changed — please sign again/i)).toBeDefined();
  });

  it("says nothing when the list changes before anyone has signed", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));

    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });

  it("drops the notice once the recipient signs again", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);

    await user.click(screen.getByRole("button", { name: "simulate-sign" }));
    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    expect(await screen.findByText(/please sign again/i)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "simulate-sign" }));
    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });

  // The COMMON case: a DCSIM recipient with no saved signatures draws. If onChange
  // is not wired to TechnicianSignatureField, the remount wipes the ink with NO
  // notice — the silent glitch the rule exists to prevent.
  it("clears a DCSIM recipient's DRAWN signature, with the notice", async () => {
    const user = userEvent.setup();
    const { container } = renderForm(undefined, TWO);
    await user.click(dcsimBox("Recipient")); // recipient is DCSIM -> TechnicianSignatureField
    await user.click(screen.getByRole("button", { name: "dcsim-draw" }));
    expect(sig(container).value).toBe("data:image/png;base64,DRAWN");

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));

    expect(sig(container).value).toBe("");
    expect(await screen.findByText(/Items changed — please sign again/i)).toBeDefined();
  });

  // A picked saved signature is also an attestation to a list. And the notice must
  // CLEAR on re-pick, or it sticks forever under a valid, freshly-picked signature.
  it("clears a DCSIM recipient's PICKED signature and drops the notice on re-pick", async () => {
    const user = userEvent.setup();
    renderForm(undefined, TWO);
    await user.click(dcsimBox("Recipient"));
    await user.click(screen.getByRole("button", { name: "dcsim-pick" }));

    await user.click(screen.getByRole("button", { name: /Remove HP G8, serial SN2/i }));
    expect(await screen.findByText(/please sign again/i)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "dcsim-pick" }));
    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });
});

describe("ReceiptBuilderForm — scanning adds items", () => {
  const HP = { ok: true as const, item: { id: "i2", make: "HP", model: "G8", serialNumber: "SN2" }, holderName: null };

  const openScanner = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /Scan to add/i }));

  beforeEach(() => lookupScannedItem.mockResolvedValue(HP));

  it("adds a scanned item to the list", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText("SN2")).toBeDefined();
    expect(lookupScannedItem).toHaveBeenCalledWith("i2");
  });

  it("posts the scanned item alongside the original", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));
    await screen.findByText("SN2");
    await user.click(screen.getByRole("button", { name: "emit-close" }));

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1", "i2"]);
  });

  it("rejects a foreign QR without calling the server", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-junk" }));

    expect(await screen.findByText(/Not an item code/i)).toBeDefined();
    expect(lookupScannedItem).not.toHaveBeenCalled();
  });

  it("names the duplicate rather than adding it twice", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i1" }));

    expect(await screen.findByText(/Already added — Dell L5420 · SN SN1/i)).toBeDefined();
    expect(lookupScannedItem).not.toHaveBeenCalled();
  });

  it("refuses a retired item", async () => {
    lookupScannedItem.mockResolvedValue({ ok: false, code: "RETIRED" });
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/That item is retired and can't be transferred/i)).toBeDefined();
    expect(screen.queryByText("SN2")).toBeNull();
  });

  it("refuses an unknown item", async () => {
    lookupScannedItem.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/That item no longer exists/i)).toBeDefined();
  });

  it("surfaces a lookup failure", async () => {
    lookupScannedItem.mockResolvedValue({ ok: false, code: "FAILED" });
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/Couldn't look up that item — try again/i)).toBeDefined();
  });

  // A QR sitting in frame decodes many times a second. The SECOND decode here
  // is caught by the duplicate-item check (i2 is already on the list) — that is
  // fine, but it does not exercise the time-window dedupe. The next test does.
  it("does not add the same item twice from repeated decodes", async () => {
    const user = userEvent.setup();
    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));
    await screen.findByText("SN2");
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(lookupScannedItem).toHaveBeenCalledTimes(1);
  });

  // Concurrency safety — the CRITICAL bug the review caught. The decode loop
  // fires onDecode without awaiting, so two lookups can be in flight at once. A
  // handler that appended from a captured `items` snapshot would let the second
  // resolution overwrite the first and silently drop a laptop off a custody
  // document, AFTER the operator heard the beep confirming it. The `looking`
  // guard serializes lookups; the live-ref append composes. With a DEFERRED
  // first lookup, the overlapping second decode is dropped (not confirmed, so
  // never falsely reported), and once the first resolves a re-emit of the
  // second lands ON TOP of it — both items survive.
  it("never drops a confirmed item when two scans overlap", async () => {
    const user = userEvent.setup();
    const HP3 = { ok: true as const, item: { id: "i3", make: "Acer", model: "A1", serialNumber: "SN3" }, holderName: null };
    let releaseI2: (v: typeof HP) => void = () => {};
    lookupScannedItem.mockImplementation((id: string) =>
      id === "i2" ? new Promise((r) => { releaseI2 = r; }) : Promise.resolve(HP3));

    renderForm();
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" })); // in flight, not resolved
    await user.click(screen.getByRole("button", { name: "emit-i3" })); // overlaps -> dropped by the guard
    expect(screen.queryByText("SN3")).toBeNull();

    releaseI2(HP);                        // i2 resolves and is added
    expect(await screen.findByText("SN2")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "emit-i3" })); // re-scan i3, now free
    expect(await screen.findByText("SN3")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "emit-close" }));

    await fillParty(user, "Sender");
    await fillParty(user, "Recipient");
    await user.click(screen.getByRole("button", { name: /Create hand receipt/i }));
    await waitFor(() => expect(createReceiptAction).toHaveBeenCalled());

    // BOTH survive: i2 was not clobbered by i3 landing on a stale snapshot.
    const posted = createReceiptAction.mock.calls[0][1] as FormData;
    expect(posted.getAll("itemId")).toEqual(["i1", "i2", "i3"]);
  });

  // Per the spec: added, not blocked — a dead end at the cart is worse. But the
  // toast vanishes while the operator is looking at a laptop, so the row keeps
  // saying it, right up to signature time.
  it("adds an item held by someone else, and keeps saying so on the row", async () => {
    lookupScannedItem.mockResolvedValue({ ...HP, holderName: "CPL Jones" });
    const user = userEvent.setup();
    renderForm({ isDcsim: false, name: "SGT Smith", rank: "SGT", unit: "A Co", contact: "5551112222", email: "s@x.mil" });
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText("SN2")).toBeDefined();
    // Two elements now legitimately carry this text — the scan-time toast (via
    // the mock's `notice`, matching the real sheet) and the persistent row
    // marker — so a bare findByText double-matches. Scope each query to prove
    // BOTH halves of the "double duty" spec without colliding.
    expect((await screen.findByTestId("scan-notice")).textContent).toMatch(/held by CPL Jones, not SGT Smith/i);
    expect(within(screen.getByRole("table")).getByText(/Held by CPL Jones, not SGT Smith/i)).toBeDefined();
  });

  it("says nothing about a holder that matches the sender", async () => {
    lookupScannedItem.mockResolvedValue({ ...HP, holderName: "SGT Smith" });
    const user = userEvent.setup();
    renderForm({ isDcsim: false, name: "SGT Smith", rank: "SGT", unit: "A Co", contact: "5551112222", email: "s@x.mil" });
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    await screen.findByText("SN2");
    // A matching holder means holderNote is "" — no row marker, and the
    // notice text (the plain "Added: …" ok toast, no holder clause) doesn't
    // mention a holder either.
    expect(screen.queryByText(/Held by/i)).toBeNull();
  });

  // Replacing a half-filled form with a card (what the server gate does on load)
  // would destroy the operator's work — the exact thing this design avoids.
  it("refuses a scan that would overflow the receipt, leaving the form alone", async () => {
    const full = Array.from({ length: 18 }, (_, k) => ({
      itemId: `f${k}`, make: `Make${k}`, model: "M", serialNumber: `S${k}`, holderName: null,
    }));
    const user = userEvent.setup();
    renderForm(undefined, full);
    await openScanner(user);
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText(/This receipt is full — 18 item types max/i)).toBeDefined();
    expect(screen.queryByText("SN2")).toBeNull();
  });
});
