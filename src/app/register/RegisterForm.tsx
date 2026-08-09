"use client";
import Link from "next/link";
import { useActionState, useState, useSyncExternalStore } from "react";
import { registerAction } from "@/app/actions/auth";
import { TurnstileWidget, type TurnstileStatus } from "@/components/TurnstileWidget";

/**
 * The interactive half of /register. Mirrors LoginForm deliberately, including
 * the hydration guard: deriving the disabled state from the challenge alone put
 * `<button disabled>` into the initial HTML, so any failure that stopped the
 * client bundle left an inert form with no message and no way to proceed. A
 * sign-up form has exactly that failure mode, so it gets exactly that fix.
 */
export function RegisterForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [state, action, pending] = useActionState(registerAction, undefined);
  const [challenge, setChallenge] = useState<TurnstileStatus>(
    turnstileSiteKey ? "pending" : "ready",
  );
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const waiting = hydrated && challenge === "pending";

  // Deliberately identical for a fresh address and one already registered —
  // the action is generic for anti-enumeration reasons and the UI must not
  // undo that by saying "that address is taken".
  if (state && "ok" in state && state.ok) {
    return (
      <div className="stack-sm">
        <p className="alert-success" role="status">
          Check your email. If that address can be registered, we&rsquo;ve sent a confirmation
          link — it expires in 24 hours. You can sign in once you confirm.
        </p>
        <Link href="/login" className="btn btn-secondary btn-block">Back to sign in</Link>
      </div>
    );
  }

  return (
    <form action={action} className="stack">
      <div className="field">
        <label className="label" htmlFor="name">Full name<span className="req"> *</span></label>
        <input id="name" className="input" name="name" required autoComplete="name" />
      </div>
      <div className="field">
        <label className="label" htmlFor="email">Email<span className="req"> *</span></label>
        {/* type="email" IS right here, unlike the item card's currentUserEmail:
            that field holds free text the CSV importer copies verbatim, while
            this one is a real credential validated by emailField server-side. */}
        <input id="email" className="input" name="email" type="email" required autoComplete="username" />
      </div>
      <div className="field">
        <label className="label" htmlFor="password">Password<span className="req"> *</span></label>
        <input
          id="password"
          className="input"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <p className="subtle" style={{ fontSize: 13, marginTop: 6 }}>At least 8 characters.</p>
      </div>
      <div className="field">
        <label className="label" htmlFor="rank">Rank</label>
        <input id="rank" className="input" name="rank" maxLength={20} />
      </div>
      <div className="field">
        <label className="label" htmlFor="unit">Unit</label>
        <input id="unit" className="input" name="unit" autoComplete="organization" />
      </div>
      <div className="field">
        <label className="label" htmlFor="contactNumber">Contact number</label>
        <input id="contactNumber" className="input" name="contactNumber" inputMode="tel" autoComplete="tel" />
      </div>
      {turnstileSiteKey && (
        <TurnstileWidget siteKey={turnstileSiteKey} resetOn={state} onStatus={setChallenge} />
      )}
      {state && "error" in state && state.error && (
        <p role="alert" className="alert-error">{state.error}</p>
      )}
      <button disabled={pending || waiting} type="submit" className="btn btn-primary btn-block">
        {pending ? "Creating your account…" : waiting ? "Checking your browser…" : "Create account"}
      </button>
      <p className="subtle" style={{ textAlign: "center", margin: 0 }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </form>
  );
}
