// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { LoginForm } from "./LoginForm";

vi.mock("@/app/actions/auth", () => ({ loginAction: vi.fn() }));

// The widget skips loading its script when `window.turnstile` already exists,
// so setting it here exercises the REAL component rather than a stub of it —
// including the callback wiring, which is the part that was broken.
type RenderOpts = {
  callback?: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
};
let lastOpts: RenderOpts | undefined;

beforeEach(() => {
  lastOpts = undefined;
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_el: HTMLElement, opts: RenderOpts) => {
      lastOpts = opts;
      return "widget-1";
    },
    reset: vi.fn(),
    remove: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  vi.clearAllMocks();
});

// jest-dom is not installed here, so assert on the DOM property directly.
const submit = () =>
  screen.getByRole("button", { name: /sign in|checking your browser/i }) as HTMLButtonElement;

describe("LoginForm with Turnstile configured", () => {
  it("holds the submit button until the challenge produces a token", async () => {
    // The bug this pins, confirmed in a real browser against real keys: typing
    // an email and password takes a second or two, and submitting before
    // Cloudflare answers sends a form with no token — which the server
    // correctly refuses with "could not verify that request came from a
    // browser", for a completely valid login.
    render(<LoginForm turnstileSiteKey="1x00000000000000000000AA" />);

    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toMatch(/checking your browser/i);

    await waitFor(() => expect(lastOpts?.callback).toBeTypeOf("function"));
    act(() => lastOpts!.callback!("a-token"));

    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(submit().textContent).toMatch(/sign in/i);
  });

  it("releases the button when the challenge cannot run at all", async () => {
    // A blocked CDN or an offline tab. The server will refuse the tokenless
    // submission with a message the user can act on — a button that can never
    // be pressed, with nothing explaining why, is worse.
    render(<LoginForm turnstileSiteKey="1x00000000000000000000AA" />);
    await waitFor(() => expect(lastOpts?.["error-callback"]).toBeTypeOf("function"));

    act(() => lastOpts!["error-callback"]!());
    await waitFor(() => expect(submit().disabled).toBe(false));
  });

  it("re-arms the deadline after a rejected attempt, not just on mount", async () => {
    // The commonest path there is: one mistyped password. `resetOn` changes,
    // the widget goes back to `pending`, and Cloudflare — more suspicious after
    // a failed sign-in — never calls back. Armed only on mount, the deadline
    // had already been cleared by the first verdict, so the button stayed
    // disabled at "Checking your browser…" until a full page reload.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = render(
      <LoginForm turnstileSiteKey="1x00000000000000000000AA" />,
    );
    await waitFor(() => expect(lastOpts?.callback).toBeTypeOf("function"));
    act(() => lastOpts!.callback!("a-token"));
    await waitFor(() => expect(submit().disabled).toBe(false));

    // A rejected submission hands `useActionState` a new state object.
    act(() => {
      rerender(<LoginForm turnstileSiteKey="1x00000000000000000000AA" />);
      lastOpts!["expired-callback"]!(); // stands in for the resetOn transition
    });
    await waitFor(() => expect(submit().disabled).toBe(true));

    // …and this time nothing ever answers.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await waitFor(() => expect(submit().disabled).toBe(false));
    vi.useRealTimers();
  });

  it("holds it again when a token expires", async () => {
    // Tokens live ~5 minutes; the widget auto-refreshes, but the form must not
    // submit during the gap carrying nothing.
    render(<LoginForm turnstileSiteKey="1x00000000000000000000AA" />);
    await waitFor(() => expect(lastOpts?.callback).toBeTypeOf("function"));

    act(() => lastOpts!.callback!("a-token"));
    await waitFor(() => expect(submit().disabled).toBe(false));

    act(() => lastOpts!["expired-callback"]!());
    await waitFor(() => expect(submit().disabled).toBe(true));
  });
});

describe("LoginForm without Turnstile", () => {
  it("behaves exactly as it did before the challenge existed", async () => {
    // The config gate is the common case — no keys on this deployment yet. The
    // button must not wait for something that is never coming.
    render(<LoginForm turnstileSiteKey={null} />);
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toMatch(/^sign in$/i);
  });
});
