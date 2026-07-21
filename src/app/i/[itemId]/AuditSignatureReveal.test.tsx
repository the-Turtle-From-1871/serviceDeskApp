// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/app/actions/audit", () => ({ revealAuditSignatureAction: vi.fn() }));
import { revealAuditSignatureAction } from "@/app/actions/audit";
import { AuditSignatureReveal } from "./AuditSignatureReveal";

afterEach(cleanup);

describe("AuditSignatureReveal", () => {
  it("hides the signature behind a button, then shows the image after a click", async () => {
    vi.mocked(revealAuditSignatureAction).mockResolvedValueOnce("data:image/png;base64,SIG");
    render(<AuditSignatureReveal auditId="a1" signerName="SGT Alvarez" />);

    // No image up front — only the reveal button.
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));

    const img = await screen.findByRole("img", { name: /signature of SGT Alvarez/i });
    expect((img as HTMLImageElement).src).toContain("data:image/png;base64,SIG");
    expect(revealAuditSignatureAction).toHaveBeenCalledWith("a1");
  });

  it("shows a retry label when the signature can't be loaded", async () => {
    vi.mocked(revealAuditSignatureAction).mockResolvedValueOnce(null);
    render(<AuditSignatureReveal auditId="a1" signerName="SGT Alvarez" />);

    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));
    expect(await screen.findByRole("button", { name: /couldn't load — retry/i })).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
