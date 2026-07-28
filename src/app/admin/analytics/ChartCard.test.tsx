// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChartCard } from "./ChartCard";

afterEach(cleanup);

const LEGEND = [
  { label: "Laptops", color: "#0b6bcb" },
  { label: "Switches", color: "#e0a30c" },
];

const card = (extra?: Partial<React.ComponentProps<typeof ChartCard>>) => (
  <ChartCard
    title="DA Form 2062 volume"
    legend={LEGEND}
    exportBase="transfer-volume"
    exportParts={["90d"]}
    exportColumns={["Month", "Laptops"]}
    exportRows={[{ Month: "Jul 26", Laptops: 3 }]}
    {...extra}
  >
    <div data-testid="plot" />
  </ChartCard>
);

/**
 * These pin DOM NESTING, not appearance — jsdom has no layout engine, so it is
 * no evidence for how the card looks (CLAUDE.md). What it can prove is the
 * structural fact the PNG export depends on: `downloadPng` rasterizes the
 * captureRef subtree, so a legend rendered outside it is absent from every
 * exported image. That regression shipped once and no test could see it.
 */
describe("ChartCard", () => {
  // Bound to the capture element itself, not to a styling class it happens to
  // carry: a `div.bg-card` selector would break on any background change (three
  // tests failing for an unrelated reason) and, worse, could match a wrapper
  // that contains the legend while captureRef no longer does — passing while
  // the PNG silently loses its colour key again.
  const capture = () => document.querySelector("[data-slot=chart-capture]");

  it("renders the legend INSIDE the captured subtree, so PNG exports keep the colour key", () => {
    render(card());
    const legend = screen.getByRole("list");
    expect(capture()).not.toBeNull();
    expect(capture()!.contains(legend)).toBe(true);
    expect(legend.textContent).toContain("Laptops");
  });

  it("keeps the actions menu OUT of the captured subtree", () => {
    render(card());
    const menu = screen.getByRole("button", { name: /actions for/i });
    expect(capture()!.contains(menu)).toBe(false);
  });

  it("captures the plot itself", () => {
    render(card());
    expect(capture()!.contains(screen.getByTestId("plot"))).toBe(true);
  });
});
