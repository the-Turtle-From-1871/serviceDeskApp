// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { LoginForm } from "./LoginForm";
import { loginAction } from "@/app/actions/auth";

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

// jest-dom matchers are not used here, so assert on the DOM property directly.
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

describe("progressive enhancement", () => {
  it("renders the submit button ENABLED before hydration", () => {
    // The server HTML must never ship `<button disabled>`: any failure that
    // stops the client bundle running leaves an inert form with no message and
    // no way to sign in, because the 15-second release lives in that same JS.
    // Asserted through `renderToString`, which is the actual server path —
    // `render()` hydrates immediately and would hide this.
    const html = renderToString(<LoginForm turnstileSiteKey="1x00000000000000000000AA" />);
    expect(html).not.toContain("disabled");
    expect(html).toContain("Sign in");
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

describe("LoginForm password-manager autofill", () => {
  // These four attributes are the whole contract with iOS Password AutoFill,
  // and the first one reads like a mistake, so it needs pinning rather than a
  // comment alone: the field holds an EMAIL but must advertise `username`.
  // `username` is the token password managers key on for a sign-in form;
  // `email` is a contact field, so iOS offered contact-card addresses or
  // nothing, never the saved login for this site. Reverting it to the
  // "obviously correct" `email` silently removes autofill on a phone, and
  // nothing else in the suite would notice.
  const field = (id: string) => document.getElementById(id) as HTMLInputElement;

  it("advertises the sign-in pair password managers look for", () => {
    render(<LoginForm turnstileSiteKey={null} />);

    expect(field("email").getAttribute("autocomplete")).toBe("username");
    expect(field("password").getAttribute("autocomplete")).toBe("current-password");
  });

  it("keeps type=email for the keyboard, and stable id/name for the keychain", () => {
    // `type` drives the phone keyboard and is independent of the autofill
    // token. The stable `id`/`name` are a documented precondition for a browser
    // storing anything to offer back later — a generated id defeats it.
    render(<LoginForm turnstileSiteKey={null} />);

    expect(field("email").type).toBe("email");
    expect(field("email").name).toBe("email");
    expect(field("password").type).toBe("password");
    expect(field("password").name).toBe("password");
  });

  it("keeps the fields inside a form with a submit button", () => {
    // The other half of that precondition: no <form>, or no submit button, and
    // the browser has no "a login just happened" signal to save against.
    render(<LoginForm turnstileSiteKey={null} />);

    expect(field("email").form).not.toBeNull();
    expect(field("email").form).toBe(field("password").form);
    expect(submit().type).toBe("submit");
    expect(submit().form).toBe(field("email").form);
  });
});

// Both fields are `required`, and jsdom runs real constraint validation on
// submit — an empty form never dispatches the event at all, so filling them is
// what makes the action run rather than test decoration.
const fillAndSubmit = () => {
  fireEvent.change(document.getElementById("email")!, {
    target: { value: "admin@example.com" },
  });
  fireEvent.change(document.getElementById("password")!, {
    target: { value: "ChangeMe123!" },
  });
  fireEvent.click(submit());
};

describe("LoginForm post-sign-in navigation", () => {
  // The other half of the autofill contract, and the one correct attributes
  // cannot supply on their own. WebKit offers to SAVE a password only after a
  // form submission followed by a real DOCUMENT navigation; a Server Action
  // `redirect()` is a React router navigation, so nothing was ever written to
  // the iOS keychain and Password AutoFill had nothing to offer back on the
  // next visit. `loginAction` therefore returns `{ ok: true }` and the leaving
  // is done here. Restoring `redirect()` in the action would silently remove
  // autofill on a phone again, with every attribute above still correct.

  // NOTE ON COVERAGE: the `window.location.assign` call itself is NOT asserted
  // here, and cannot be. jsdom's `location.assign` is a non-configurable own
  // property (`vi.spyOn` fails with "Cannot redefine property"), and jsdom has
  // no navigation to observe even if it could be stubbed — the very reason this
  // repo treats jsdom as no evidence for browser behaviour. What IS pinned here
  // is the DOM contract the navigation rides on; that a real DOCUMENT
  // navigation follows is pinned in `tests/e2e/auth.spec.ts`, where a browser
  // can actually be asked.

  it("leaves the page with NO JS too, via a hoisted meta refresh", async () => {
    // Progressive enhancement: the action's own `redirect()` used to move a
    // scriptless browser off the login page. Returning a value instead means a
    // successful sign-in would otherwise re-render /login with no indication
    // anything happened — signed in, and stranded. React 19 hoists the <meta>
    // into <head>, so it is an ordinary document-level refresh.
    vi.mocked(loginAction).mockResolvedValue({ ok: true });

    render(<LoginForm turnstileSiteKey={null} />);
    fillAndSubmit();

    await waitFor(() => {
      const meta = document.querySelector('meta[http-equiv="refresh"]');
      expect(meta?.getAttribute("content")).toBe("0;url=/items");
    });
    // Last resort if the refresh itself is blocked. A plain <a>, not a <Link>:
    // it has to be a full navigation for the same reason all of this does.
    const link = screen.getByRole("link", { name: /continue to your items/i });
    expect(link.getAttribute("href")).toBe("/items");
  });

  it("keeps the button held while the navigation is in flight", async () => {
    // `pending` goes false the moment the action returns, so without this the
    // form would flash back to an armed "Sign in" underneath a page that is
    // already leaving — and a second tap would spend another rate-limit token.
    vi.mocked(loginAction).mockResolvedValue({ ok: true });

    render(<LoginForm turnstileSiteKey={null} />);
    fillAndSubmit();

    // Queried without a name filter on purpose: the shared `submit()` helper
    // matches /sign in/, which "Signing in…" does NOT contain, so using it here
    // would fail on the very state this test exists to observe. It is the only
    // button in the form when Turnstile is unconfigured.
    const button = () => screen.getByRole("button") as HTMLButtonElement;
    await waitFor(() => expect(button().disabled).toBe(true));
    expect(button().textContent).toMatch(/signing in/i);
  });

  it("shows a rejected sign-in as an error and leaves the form armed", async () => {
    // The union the action now returns has two arms, and the error arm must not
    // regress: no meta refresh, no held button, and the message still rendered.
    vi.mocked(loginAction).mockResolvedValue({ error: "Invalid email or password." });

    render(<LoginForm turnstileSiteKey={null} />);
    fillAndSubmit();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/invalid email or password/i),
    );
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(submit().disabled).toBe(false);
  });
});
