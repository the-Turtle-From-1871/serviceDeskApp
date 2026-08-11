"use client";
import Link from "next/link";
import { useActionState, useEffect, useState, useSyncExternalStore } from "react";
import { loginAction } from "@/app/actions/auth";
import { LOGIN_DESTINATION } from "@/lib/login-destination";
import { TurnstileWidget, type TurnstileStatus } from "@/components/TurnstileWidget";
import { ResendVerificationForm } from "@/components/ResendVerificationForm";

// The interactive part of /login. Split out so the page shell (brand, headings)
// stays a Server Component instead of shipping as client JS.
//
// `turnstileSiteKey` is resolved by the page (a Server Component) and is null
// when Turnstile is not configured, so the decision to challenge is made on the
// server rather than from a `NEXT_PUBLIC_` read in the browser. The server
// action verifies independently either way — a client that skips the widget
// gains nothing.
export function LoginForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [state, action, pending] = useActionState(loginAction, undefined);
  // `ready` when there is no challenge to wait for, so the button behaves
  // exactly as it did before Turnstile existed.
  const [challenge, setChallenge] = useState<TurnstileStatus>(
    turnstileSiteKey ? "pending" : "ready",
  );

  // Held until Cloudflare answers. Filling in an email and password takes a
  // second or two, and submitting first sends a tokenless form — which the
  // server correctly refuses with "could not verify that request came from a
  // browser", for a completely valid login. An `error` state still submits: the
  // challenge could not run at all, and a button that can never be pressed is
  // worse than a refusal that says something.
  // `hydrated` is what keeps the SERVER-rendered button enabled.
  //
  // Deriving `waiting` from the challenge alone put `<button disabled>` in the
  // initial HTML, so any failure that stops the client bundle running — a
  // content filter, a parse error, a throw before the widget's effects — left
  // an inert form with no message and no way to sign in, because the 15-second
  // release lives in that same JS. It also defeated React's progressive
  // enhancement, which would otherwise POST the form action natively.
  //
  // Enabled until proven otherwise: if JS never runs the form still submits and
  // the server refuses it with something readable.
  // `useSyncExternalStore` rather than a state-setting effect: it returns the
  // server snapshot (false) during SSR and the client one (true) once mounted,
  // with no cascading render — which is what the lint rule about setState in an
  // effect is there to prevent.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const waiting = hydrated && challenge === "pending";

  // The sign-in succeeded and this page is on its way out.
  //
  // `loginAction` returns success instead of redirecting, so that the departure
  // is a FULL-PAGE navigation rather than a React router one. WebKit's "save
  // this password?" prompt only fires on a real document navigation after a
  // form submission, and without that prompt nothing is ever written to the
  // iOS keychain — so Password AutoFill has nothing to offer on the next visit,
  // which is indistinguishable from the autofill attributes being wrong. See
  // the matching comment on the action's success path.
  const signedIn = Boolean(state && "ok" in state && state.ok);

  useEffect(() => {
    if (signedIn) window.location.assign(LOGIN_DESTINATION);
  }, [signedIn]);

  // The resend control is a SIBLING of the sign-in form, never a child of it.
  //
  // It renders its own <form>, and an HTML parser DROPS a <form> nested inside
  // another one — so while this block lived inside the sign-in form, the
  // server-rendered markup contained no resend control at all and it existed
  // only because React inserted it after hydration. Chrome said so out loud
  // ("In HTML, <form> cannot be a descendant of <form>. This will cause a
  // hydration error"), and it failed on exactly the path a blocked user lands
  // on. The parent is a `.card.stack`, so two siblings space themselves.
  //
  // Not solved with `formAction` on a button: that submits THIS form, which
  // would post the user's password to the resend endpoint, which has no use for
  // it. Not solved with a JS-only button either — this file works hard to keep
  // sign-in functional without the client bundle (see `hydrated` above and the
  // <meta refresh> below), and a button that needs JS would quietly opt the
  // resend path out of that.
  return (
    <>
      <form action={action} className="stack">
      <div className="field">
        <label className="label" htmlFor="email">Email</label>
        {/* `autoComplete="username"`, NOT `"email"`, even though this field holds
            an email and keeps `type="email"` for the keyboard. `username` is the
            token password managers key on for a sign-in form; `email` is a
            CONTACT field, so iOS offered contact-card addresses (or nothing) and
            never the saved login for this site — which is what someone tapping
            the field on a phone is actually reaching for. `id`/`name` stay
            `email`: iOS also requires a stable id/name inside a <form> with a
            submit button before it will store anything to offer back. */}
        <input id="email" className="input" name="email" type="email" required autoComplete="username" />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" name="password" type="password" required autoComplete="current-password" />
        <Link href="/forgot-password" className="subtle" style={{ fontSize: 13, marginTop: 6, display: "inline-block" }}>Forgot password?</Link>
      </div>
      {/* `resetOn={state}` replaces the spent challenge after a rejected
          attempt — a token is single-use, so without it the second sign-in try
          would be refused for a reason the user cannot see. */}
      {turnstileSiteKey && (
        <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} onStatus={setChallenge} />
      )}
      {state && "error" in state && state.error && (
        <p role="alert" className="alert-error">{state.error}</p>
      )}
      {/* The no-JS half of the navigation above. React 19 hoists <meta> into
          <head>, so this is an ordinary document-level refresh — which is also
          what keeps progressive enhancement intact: without it a browser
          running no client bundle would sign in successfully and then sit on
          the login page with nothing to say so. The plain <a> (not <Link>) is
          the last resort if a refresh is blocked, and is a full navigation for
          the same reason the rest of this is. */}
      {signedIn && (
        <>
          <meta httpEquiv="refresh" content={`0;url=${LOGIN_DESTINATION}`} />
          <p role="status" className="subtle">
            Signed in — <a href={LOGIN_DESTINATION}>continue to your items</a>.
          </p>
        </>
      )}
      <button
        disabled={pending || waiting || signedIn}
        type="submit"
        className="btn btn-primary btn-block"
      >
        {pending || signedIn ? "Signing in…" : waiting ? "Checking your browser…" : "Sign in"}
      </button>
      <p className="subtle" style={{ textAlign: "center", margin: 0 }}>
        Don&rsquo;t have an account? <Link href="/register">Create one</Link>
      </p>
      </form>
      {/* Right password, unconfirmed address. Safe to name specifically ONLY
          because reaching this state required the correct password — see
          modules/auth/credentials.ts. */}
      {state && "unverified" in state && (
        <div className="alert-warning stack-sm" role="alert">
          <p style={{ margin: 0 }}>
            Confirm your email address before signing in. We sent a link to{" "}
            <strong>{state.email}</strong>.
          </p>
          <ResendVerificationForm email={state.email} />
        </div>
      )}
    </>
  );
}
