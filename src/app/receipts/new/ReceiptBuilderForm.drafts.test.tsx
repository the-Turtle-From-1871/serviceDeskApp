// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/actions/receipts", () => ({ createReceiptAction: vi.fn() }));
// Referenced by NAME (not an inline factory-local `vi.fn()`) so the
// Save-draft-checkbox test below can make Save draft actually SETTLE — the
// mechanism the whole bug depends on (React resets the form after any
// settled action, success included).
const saveDraftAction = vi.fn();
vi.mock("@/app/actions/drafts", () => ({
  saveDraftAction: (prev: unknown, fd: FormData) => saveDraftAction(prev, fd),
}));
// Referenced by NAME (not an inline factory-local `vi.fn()`) so the resume-qty
// tests below can configure what a scan resolves to — mirrors
// ReceiptBuilderForm.test.tsx's own `lookupScannedItem` mock.
const lookupScannedItem = vi.fn();
vi.mock("@/app/actions/scan", () => ({
  lookupScannedItem: (id: string) => lookupScannedItem(id),
}));
// A minimal stand-in for the camera sheet, same shape as
// ReceiptBuilderForm.test.tsx's — one button that emits one decoded item URL.
// jsdom has no camera; the real component would just report "unavailable".
vi.mock("@/components/QrScanner", () => ({
  QrScanner: ({ onDecode }: { onDecode: (t: string) => void }) => (
    <div>
      <button type="button" onClick={() => onDecode("https://x.example/i/i2")}>emit-i2</button>
    </div>
  ),
}));
vi.mock("@/lib/beep", () => ({ beep: vi.fn() }));
// jsdom has no canvas backend, so the real SignaturePad's `getContext("2d")!`
// returns null and its mount effect throws the instant it renders — none of
// these tests exercise signing, so stub it out exactly like
// ReceiptBuilderForm.test.tsx already does for the same reason.
vi.mock("@/components/SignaturePad", () => ({
  SignaturePad: ({ name }: { name: string }) => <input type="hidden" name={name} />,
}));

import { ReceiptBuilderForm } from "./ReceiptBuilderForm";
import { receiptDraftSchema } from "@/modules/receipts/drafts.schema";
import { formatDroppedItemsNotice } from "@/modules/receipts/drafts.resume";

const ITEMS = [{ itemId: "i1", make: "Dell", model: "5420", serialNumber: "SN1", holderName: null }];

afterEach(cleanup);

describe("Save draft button", () => {
  it("renders in the page header, to the right of the title", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    const btn = screen.getByRole("button", { name: /save draft/i });
    expect(btn).toBeTruthy();
    expect(screen.getByRole("heading", { name: /new hand receipt/i })).toBeTruthy();
    // `.spacer` is what pushes it opposite the title in the shared `.row` idiom.
    expect(btn.className).toContain("spacer");
  });

  it("carries formNoValidate so a half-filled form can still be saved", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    const btn = screen.getByRole("button", { name: /save draft/i }) as HTMLButtonElement;
    expect(btn.formNoValidate).toBe(true);
    expect(btn.type).toBe("submit");
  });

  it("posts a draftId when resuming, so a re-save updates rather than duplicates", () => {
    const { container } = render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d9" />);
    const hidden = container.querySelector('input[name="draftId"]') as HTMLInputElement;
    expect(hidden.value).toBe("d9");
  });

  it("posts an empty draftId on a fresh builder", () => {
    const { container } = render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    const hidden = container.querySelector('input[name="draftId"]') as HTMLInputElement;
    expect(hidden.value).toBe("");
  });
});

describe("resuming a draft", () => {
  const values = receiptDraftSchema.parse({
    itemIds: ["i1"],
    receiver: { name: "Doe, Jane", unit: "A Co" },
    returnDays: "7",
  });

  it("tells the operator they must sign again", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);
    expect(screen.getByText(/please sign again/i)).toBeTruthy();
  });

  it("restores the typed recipient and return timer", () => {
    const { container } = render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);
    expect((container.querySelector('input[name="receiverName"]') as HTMLInputElement).value).toBe("Doe, Jane");
    expect((container.querySelector('input[name="returnDays"]') as HTMLInputElement).value).toBe("7");
  });

  it("names the dropped device by serial, in a single role=alert element", () => {
    // Real formatter, not a hand-typed literal: proves the component renders
    // whatever formatDroppedItemsNotice produces VERBATIM, with no re-wording
    // or re-pluralizing of its own — the naming logic lives in one place.
    const notice = formatDroppedItemsNotice([{ id: "i2", serialNumber: "SN2", make: "Dell", model: "5420" }]);
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} droppedItemsNotice={notice} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("SN2");
    expect(alert.textContent).toContain("Dell 5420");
    expect(alert.className).toContain("alert-error");
  });

  it("shows no dropped-items alert when nothing was dropped", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} droppedItemsNotice="" />);
    expect(screen.queryByText(/no longer/i)).toBeNull();
  });

  it("shows no restore notice on a fresh builder", () => {
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);
    expect(screen.queryByText(/please sign again/i)).toBeNull();
  });
});

describe("resuming a draft — quantity tracking (frozen-qty regression)", () => {
  const issued = () => screen.getByLabelText("Quantity issued, Dell 5420") as HTMLInputElement;

  const HP2 = { ok: true as const, item: { id: "i2", make: "Dell", model: "5420", serialNumber: "SN2" }, holderName: null };

  it("keeps an untouched resumed line tracking when a matching item is added", async () => {
    // Saved qty (1) equals the live default for a single-item line: this must
    // be treated as "never touched", not as a frozen override.
    const values = receiptDraftSchema.parse({
      itemIds: ["i1"],
      lines: [{ make: "Dell", model: "5420", qtyAuth: "1", qtyIssued: "1" }],
    });
    lookupScannedItem.mockResolvedValue(HP2);
    const user = userEvent.setup();
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);

    expect(issued().value).toBe("1");
    await user.click(screen.getByRole("button", { name: /Scan to add/i }));
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    // Grew to 2 — proves the resumed line was left ABSENT from qtyEdits and is
    // still deriving from the live item count, not frozen at the saved "1".
    expect(await screen.findByText("SN2")).toBeDefined();
    expect(issued().value).toBe("2");
  });

  it("preserves a deliberately edited resumed quantity and does not track", async () => {
    // Saved qty (5) does NOT match the live default (1): this is the
    // operator's explicit value and must survive, even once more items land.
    const values = receiptDraftSchema.parse({
      itemIds: ["i1"],
      lines: [{ make: "Dell", model: "5420", qtyAuth: "5", qtyIssued: "5" }],
    });
    lookupScannedItem.mockResolvedValue(HP2);
    const user = userEvent.setup();
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);

    expect(issued().value).toBe("5");
    await user.click(screen.getByRole("button", { name: /Scan to add/i }));
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText("SN2")).toBeDefined();
    expect(issued().value).toBe("5"); // unchanged — the override still wins
  });

  it("decides per FIELD: an edited Authorized does not refreeze an untouched Issued", async () => {
    // Authorized was edited away from the live default (1 -> 3); Issued was
    // left at the live default (1). Requiring BOTH fields to match before
    // treating the LINE as untouched would wrongly write a whole-line
    // override here, refreezing Issued even though the operator never typed
    // into it — the exact wrong-count-on-a-signed-receipt bug Finding 1 was
    // about, one level finer.
    const authInput = () => screen.getByLabelText("Quantity authorized, Dell 5420") as HTMLInputElement;
    const values = receiptDraftSchema.parse({
      itemIds: ["i1"],
      lines: [{ make: "Dell", model: "5420", qtyAuth: "3", qtyIssued: "1" }],
    });
    lookupScannedItem.mockResolvedValue(HP2);
    const user = userEvent.setup();
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);

    expect(authInput().value).toBe("3");
    expect(issued().value).toBe("1");
    await user.click(screen.getByRole("button", { name: /Scan to add/i }));
    await user.click(screen.getByRole("button", { name: "emit-i2" }));

    expect(await screen.findByText("SN2")).toBeDefined();
    expect(authInput().value).toBe("3"); // the operator's edit still wins
    expect(issued().value).toBe("2"); // untouched field still tracks upward
  });
});

// CRITICAL Finding 1: ServiceControls' "Needs service?" checkbox is
// `checked={needs}` with no `defaultChecked` sync — the exact defect class
// PartyFields' `dcsimRef` (top of this file) already exists to defeat for the
// DCSIM checkbox, pinned there by ReceiptBuilderForm.test.tsx:131-152. Before
// this branch the only thing that settled a form was a FAILED create;
// `formAction={saveDraft}` makes a SUCCESSFUL save settle it too, and React
// resets every control to its mount-time `defaultChecked` on ANY settle. A
// ticked box silently unchecks; `needs` (React state) does not change, so the
// type/days inputs stay visible and it reads like a rendering glitch — but
// `service[itemId][needs]` then posts nothing on Create, `parseServiceMap`
// drops the flag, and the device never reaches the service queue.
describe("Save draft — a settled action must not silently clear a service flag", () => {
  const party = (p: "Sender" | "Recipient") => within(screen.getByRole("group", { name: p }));
  const dcsimBox = (p: "Sender" | "Recipient") => party(p).getByRole("checkbox") as HTMLInputElement;

  it("keeps a ticked 'Needs service?' checkbox checked after Save draft succeeds", async () => {
    saveDraftAction.mockResolvedValue({ draftId: "d1", savedAt: Date.now() });
    const user = userEvent.setup();
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} />);

    // Both parties DCSIM: the Service column only renders for a DCSIM
    // recipient, and a DCSIM party's only required field is its name — this
    // is the smallest form jsdom's native validation will accept (unlike a
    // real browser, jsdom does not appear to honor `formNoValidate` on the
    // submitter for a click-triggered submission, so the required fields must
    // actually be filled here rather than relying on that attribute alone).
    await user.click(dcsimBox("Sender"));
    await user.type(party("Sender").getByLabelText("DCSIM technician name"), "SGT Tech");
    await user.click(dcsimBox("Recipient"));
    await user.type(party("Recipient").getByLabelText("DCSIM technician name"), "SGT Other");

    const needsBox = screen.getByRole("checkbox", { name: /needs service/i }) as HTMLInputElement;
    await user.click(needsBox);
    expect(needsBox.checked).toBe(true);

    await user.click(screen.getByRole("button", { name: /save draft/i }));
    await waitFor(() => expect(saveDraftAction).toHaveBeenCalled());
    await screen.findByText(/draft saved/i);

    // The bug: React's post-settle form.reset() restores the DOM checkbox to
    // the `defaultChecked` captured at mount (false), because nothing kept it
    // in step with React state — exactly what dcsimRef prevents for the
    // sibling DCSIM checkbox.
    expect(needsBox.checked).toBe(true);
  });
});

// Finding 4: the service round-trip through resume — drafts.form.ts ->
// payload -> draftService map -> ServiceControls `initial` — is the most
// intricate restore path and exactly where Finding 1 lands, and it had no
// coverage at all.
describe("resuming a draft — the service selection round-trips", () => {
  it("restores the checkbox, type, days and note for a flagged item", async () => {
    const values = receiptDraftSchema.parse({
      itemIds: ["i1"],
      receiver: { isDcsim: true },
      service: [{ itemId: "i1", serviceType: "OTHER", note: "cracked screen", days: "5" }],
    });
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);

    const needsBox = screen.getByRole("checkbox", { name: /needs service/i }) as HTMLInputElement;
    expect(needsBox.checked).toBe(true);
    expect((screen.getByLabelText("Service type") as HTMLSelectElement).value).toBe("OTHER");
    expect((screen.getByLabelText(/service deadline in days/i) as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText(/describe the service needed/i) as HTMLInputElement).value).toBe("cracked screen");
  });

  it("leaves the checkbox unticked for an item with no saved service selection", () => {
    const values = receiptDraftSchema.parse({
      itemIds: ["i1"],
      receiver: { isDcsim: true },
      service: [],
    });
    render(<ReceiptBuilderForm initialItems={ITEMS} signatures={[]} draftId="d1" draftValues={values} />);

    expect((screen.getByRole("checkbox", { name: /needs service/i }) as HTMLInputElement).checked).toBe(false);
  });
});
