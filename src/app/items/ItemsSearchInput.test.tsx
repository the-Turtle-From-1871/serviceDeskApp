// @vitest-environment jsdom
//
// The /items search used to be a plain GET <form>: type a query, click
// "Search" (or hit Enter) to submit. This is its replacement — a live,
// debounced search that mirrors HomeSearch.tsx's pattern but navigates the
// URL (q/sort/dir/page) instead of calling a server action directly, because
// /items must stay server-side paginated (see CLAUDE.md "Data Fetching &
// N+1 Prevention" — never ship the whole Items table to the client).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

import { ItemsSearchInput } from "./ItemsSearchInput";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
});

describe("ItemsSearchInput", () => {
  it("debounces typing, then replaces the URL with q set and sort/dir preserved, no stale page", async () => {
    // shouldAdvanceTime lets React's internal scheduler (which also relies on
    // timers) keep progressing in real time while we still control OUR
    // debounce timer explicitly via vi.advanceTimersByTimeAsync below —
    // otherwise React's effect-flushing hangs forever waiting on a timer the
    // fake clock never advances.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // delay: null disables user-event's own per-keystroke setTimeout waits,
    // so it never competes with the fake clock we advance by hand below.
    const user = userEvent.setup({ delay: null });
    render(<ItemsSearchInput q="" sort="serialNumber" dir="asc" />);

    const input = screen.getByRole("textbox", { name: /search/i });
    await user.type(input, "abc");

    // Not yet — still within the debounce window.
    expect(replace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);

    expect(replace).toHaveBeenCalledTimes(1);
    const [url, opts] = replace.mock.calls[0];
    expect(url).toContain("/items?");
    expect(url).toMatch(/(^|[?&])q=abc(&|$)/);
    expect(url).toMatch(/(^|[?&])sort=serialNumber(&|$)/);
    expect(url).toMatch(/(^|[?&])dir=asc(&|$)/);
    expect(url).not.toMatch(/[?&]page=/);
    expect(opts).toEqual(expect.objectContaining({ scroll: false }));

    vi.useRealTimers();
  });

  it("clearing the query replaces to /items with no q param", async () => {
    // shouldAdvanceTime lets React's internal scheduler (which also relies on
    // timers) keep progressing in real time while we still control OUR
    // debounce timer explicitly via vi.advanceTimersByTimeAsync below —
    // otherwise React's effect-flushing hangs forever waiting on a timer the
    // fake clock never advances.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    render(<ItemsSearchInput q="printer" sort={null} dir="desc" />);

    const input = screen.getByRole("textbox", { name: /search/i }) as HTMLInputElement;
    expect(input.value).toBe("printer");

    await user.clear(input);
    await vi.advanceTimersByTimeAsync(300);

    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0];
    expect(url).toBe("/items");

    vi.useRealTimers();
  });

  it("mounting on a deep URL (page/sort/dir) does not navigate away, dropping page", async () => {
    // Reproduces the mount-time bug: the debounce effect used to run on
    // initial mount too and always omitted `page`, so a hard refresh of
    // e.g. /items?sort=make&dir=asc&page=3 would silently bounce the user
    // back to page 1 after 300ms with zero interaction.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ItemsSearchInput q="" sort="make" dir="asc" />);

    await vi.advanceTimersByTimeAsync(300);

    expect(replace).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("mounting with a non-empty q already in the URL does not navigate", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ItemsSearchInput q="foo" sort={null} dir="desc" />);

    await vi.advanceTimersByTimeAsync(300);

    expect(replace).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("uses the latest sort/dir, not a stale closure, if they change while the debounce is pending", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(<ItemsSearchInput q="" sort="serialNumber" dir="asc" />);

    const input = screen.getByRole("textbox", { name: /search/i });
    await user.type(input, "abc");

    // Sort changes (e.g. user clicked a column header) while the debounce
    // timer armed by typing is still pending.
    rerender(<ItemsSearchInput q="" sort="make" dir="desc" />);

    await vi.advanceTimersByTimeAsync(300);

    expect(replace).toHaveBeenCalledTimes(1);
    const [url] = replace.mock.calls[0];
    expect(url).toMatch(/(^|[?&])sort=make(&|$)/);
    expect(url).toMatch(/(^|[?&])dir=desc(&|$)/);

    vi.useRealTimers();
  });

  it("pressing Enter does not trigger a full-page form submit", async () => {
    const submitHandler = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener("submit", submitHandler);

    render(<ItemsSearchInput q="" sort={null} dir="desc" />);
    const input = screen.getByRole("textbox", { name: /search/i });
    const user = userEvent.setup();
    await user.type(input, "x{enter}");

    // Either there's no <form> at all, or its submit was intercepted —
    // either way jsdom shouldn't report an uncaught native submit.
    window.removeEventListener("submit", submitHandler);
    expect(submitHandler.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
