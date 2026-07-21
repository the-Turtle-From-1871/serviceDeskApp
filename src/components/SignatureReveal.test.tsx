// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignatureReveal } from "./SignatureReveal";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("SignatureReveal", () => {
  it("hides the image behind a button, fetches on first show, and toggles without re-fetching", async () => {
    const load = vi.fn().mockResolvedValueOnce("data:image/png;base64,SIG");
    render(<SignatureReveal load={load} alt="Signature of SGT Alvarez" />);

    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));

    const img = await screen.findByRole("img", { name: /signature of SGT Alvarez/i });
    expect((img as HTMLImageElement).src).toContain("data:image/png;base64,SIG");
    expect(load).toHaveBeenCalledTimes(1);

    // Hide → image gone, Show button back.
    await userEvent.click(screen.getByRole("button", { name: /hide signature/i }));
    expect(screen.queryByRole("img")).toBeNull();

    // Show again → cached image, no second fetch.
    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));
    expect(await screen.findByRole("img")).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("places the toggle button LAST when imageFirst (right-justified use)", async () => {
    const load = vi.fn().mockResolvedValueOnce("data:image/png;base64,SIG");
    const { container } = render(<SignatureReveal load={load} alt="sig" imageFirst />);
    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));
    await screen.findByRole("img");
    const kids = Array.from(container.querySelector("span")!.children).map((c) => c.tagName);
    expect(kids).toEqual(["IMG", "BUTTON"]); // image then Hide button
  });

  it("places the toggle button FIRST by default (left-anchored use)", async () => {
    const load = vi.fn().mockResolvedValueOnce("data:image/png;base64,SIG");
    const { container } = render(<SignatureReveal load={load} alt="sig" />);
    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));
    await screen.findByRole("img");
    const kids = Array.from(container.querySelector("span")!.children).map((c) => c.tagName);
    expect(kids).toEqual(["BUTTON", "IMG"]); // Hide button then image
  });

  it("shows a retry label when the image can't be loaded", async () => {
    const load = vi.fn().mockResolvedValueOnce(null);
    render(<SignatureReveal load={load} alt="sig" />);
    await userEvent.click(screen.getByRole("button", { name: /show signature/i }));
    expect(await screen.findByRole("button", { name: /couldn't load — retry/i })).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
