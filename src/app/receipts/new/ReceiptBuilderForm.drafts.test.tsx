// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/actions/receipts", () => ({ createReceiptAction: vi.fn() }));
vi.mock("@/app/actions/drafts", () => ({ saveDraftAction: vi.fn() }));
vi.mock("@/app/actions/scan", () => ({ lookupScannedItem: vi.fn() }));
// jsdom has no canvas backend, so the real SignaturePad's `getContext("2d")!`
// returns null and its mount effect throws the instant it renders — none of
// these tests exercise signing, so stub it out exactly like
// ReceiptBuilderForm.test.tsx already does for the same reason.
vi.mock("@/components/SignaturePad", () => ({
  SignaturePad: ({ name }: { name: string }) => <input type="hidden" name={name} />,
}));

import { ReceiptBuilderForm } from "./ReceiptBuilderForm";

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
