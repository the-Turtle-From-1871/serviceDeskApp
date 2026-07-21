// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/admin/actions/verify-seal", () => ({ verifyReceiptSealAction: vi.fn() }));
import { verifyReceiptSealAction } from "@/app/admin/actions/verify-seal";
import { ReceiptSealVerify } from "./ReceiptSealVerify";

// This repo's vitest.config.ts does not set `test.globals`, so
// @testing-library/react's implicit afterEach auto-cleanup never registers
// (see ItemsSearchInput.test.tsx for the same pattern) — without this, the
// second test's render leaks into the DOM from the first and getByRole finds
// two "Verify seal" buttons.
afterEach(cleanup);

describe("ReceiptSealVerify", () => {
  it("shows the VALID message after a successful verify", async () => {
    vi.mocked(verifyReceiptSealAction).mockResolvedValueOnce({ status: "VALID", sealedAt: "2026-07-20T18:04:11.482Z" });
    render(<ReceiptSealVerify receiptNumber="HR-000123" />);
    await userEvent.click(screen.getByRole("button", { name: /verify seal/i }));
    expect(await screen.findByText(/seal valid/i)).toBeTruthy();
  });

  it("shows the TAMPERED message when verification fails", async () => {
    vi.mocked(verifyReceiptSealAction).mockResolvedValueOnce({ status: "TAMPERED" });
    render(<ReceiptSealVerify receiptNumber="HR-000123" />);
    await userEvent.click(screen.getByRole("button", { name: /verify seal/i }));
    expect(await screen.findByText(/seal invalid/i)).toBeTruthy();
  });
});
