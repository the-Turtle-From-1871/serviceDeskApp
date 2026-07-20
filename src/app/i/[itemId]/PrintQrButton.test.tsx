// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrintQrButton } from "./PrintQrButton";

afterEach(cleanup);

it("invokes window.print when clicked", async () => {
  // jsdom does not implement window.print; install a spy so the click is observable.
  const printSpy = vi.fn();
  vi.stubGlobal("print", printSpy);

  render(<PrintQrButton />);
  const button = screen.getByRole("button", { name: "Print QR" });
  await userEvent.click(button);

  expect(printSpy).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

it("is marked no-print so it does not appear on the printout", () => {
  render(<PrintQrButton />);
  expect(screen.getByRole("button", { name: "Print QR" }).className).toContain("no-print");
});
