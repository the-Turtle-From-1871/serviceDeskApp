// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/actions/audit", () => ({ revealAuditSignatureAction: vi.fn() }));
import { revealAuditSignatureAction } from "@/app/actions/audit";
import { AuditSignatureReveal } from "./AuditSignatureReveal";

afterEach(cleanup);

// The reveal/toggle behavior itself is covered by SignatureReveal.test.tsx; this
// just verifies the wrapper wires the audit action + signer alt correctly.
describe("AuditSignatureReveal", () => {
  it("reveals the audit's signature via revealAuditSignatureAction with the auditId + signer alt", async () => {
    vi.mocked(revealAuditSignatureAction).mockResolvedValueOnce("data:image/png;base64,SIG");
    render(<AuditSignatureReveal auditId="a1" signerName="SGT Alvarez" />);

    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));
    const img = await screen.findByRole("img", { name: /signature of SGT Alvarez/i });
    expect((img as HTMLImageElement).src).toContain("data:image/png;base64,SIG");
    expect(revealAuditSignatureAction).toHaveBeenCalledWith("a1");
  });
});
