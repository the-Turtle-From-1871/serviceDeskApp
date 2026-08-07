// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/app/actions/drafts", () => ({ deleteDraftAction: vi.fn() }));

import { DraftList } from "./DraftList";

const DRAFTS = [
  { id: "d1", label: "Doe, Jane · 2 items", updatedAt: new Date("2026-08-06T09:00:00Z") },
  { id: "d2", label: "No recipient yet · 1 item", updatedAt: new Date("2026-08-01T09:00:00Z") },
];

afterEach(cleanup);

describe("DraftList", () => {
  it("shows an empty state when there are none", () => {
    render(<DraftList drafts={[]} />);
    expect(screen.getByText(/no saved drafts/i)).toBeTruthy();
  });

  it("lists each draft's label", () => {
    render(<DraftList drafts={DRAFTS} />);
    expect(screen.getByText("Doe, Jane · 2 items")).toBeTruthy();
    expect(screen.getByText("No recipient yet · 1 item")).toBeTruthy();
  });

  it("links Resume to the builder with the draft id", () => {
    render(<DraftList drafts={DRAFTS} />);
    const link = screen.getAllByRole("link", { name: /resume/i })[0] as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/receipts/new?draft=d1");
  });

  it("posts the draft id to the delete action", () => {
    const { container } = render(<DraftList drafts={DRAFTS} />);
    const hidden = container.querySelector('input[name="id"]') as HTMLInputElement;
    expect(hidden.value).toBe("d1");
  });

  it("gives each delete button an accessible name naming its draft", () => {
    render(<DraftList drafts={DRAFTS} />);
    expect(screen.getByRole("button", { name: /delete draft doe, jane/i })).toBeTruthy();
  });

  // Every other date surface in the app goes through formatDateTimeHST
  // (Pacific/Honolulu, no DST) so a saved time reads the same regardless of
  // the server's own locale/timezone. A bare `toLocaleString()` here rendered
  // Vercel's UTC unlabelled — this pins the shared, labelled format instead.
  it("shows the save time in HST via the shared formatter, not the server's raw locale string", () => {
    render(<DraftList drafts={DRAFTS} />);
    expect(screen.getAllByText(/Saved .*HST/).length).toBe(DRAFTS.length);
    // The un-fixed bug: Date.prototype.toLocaleString() with no arguments has
    // no "HST" suffix at all — its presence is what proves the shared helper
    // is doing the formatting, not an ad hoc call re-introduced later.
    expect(screen.queryByText(DRAFTS[0].updatedAt.toLocaleString())).toBeNull();
  });
});
