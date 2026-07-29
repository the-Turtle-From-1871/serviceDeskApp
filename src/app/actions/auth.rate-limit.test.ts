import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Everything the actions touch besides the limiter is stubbed: this file is
// about WHEN a token is spent, not about authentication itself.
const signIn = vi.fn();
const resetPasswordWithToken = vi.fn();

// `next-auth` is stubbed rather than imported: loading it under vitest fails on
// its own `next/server` import (`Cannot find module .../next/server`). The
// action only uses the class for an `instanceof` check, so a stand-in class is
// a faithful substitute — and it is the SAME class the action compares against,
// since the mock is what its import resolves to.
const { AuthError } = vi.hoisted(() => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next-auth", () => ({ AuthError }));

// `after()` defers the account lookup + email send so the action returns in
// constant time regardless of whether the address exists (the anti-enumeration
// property). Captured rather than executed, so the tests can assert WHEN it is
// scheduled relative to the rate-limit spend.
const after = vi.hoisted(() => vi.fn());
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }));

vi.mock("@/auth", () => ({
  signIn: (...a: unknown[]) => signIn(...a),
  signOut: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ default: {} }));
vi.mock("@/lib/password-reset", () => ({
  createPasswordResetToken: vi.fn(),
  resetPasswordWithToken: (...a: unknown[]) => resetPasswordWithToken(...a),
}));
vi.mock("@/modules/auth/send-password-reset-email", () => ({
  sendPasswordResetEmail: vi.fn(),
}));

const TEST_IP = "198.51.100.4";
const extraHeaders = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": TEST_IP, ...extraHeaders.current }),
}));

// `loginAction` issues its own redirect now that it decides success from a
// RETURN value rather than a thrown marker. Throwing here keeps the assertions
// able to see that it happened.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT:${url}`), { digest: "NEXT_REDIRECT" });
  },
}));

import { loginAction, requestPasswordResetAction, resetPasswordAction } from "./auth";
import {
  AUTH_POLICY,
  AUTH_SPRAY_POLICY,
  __memoryHitCountForTests,
  __resetRateLimitStateForTests,
  rateLimitIdentity,
  rateLimitKey,
} from "@/lib/rate-limit";

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

const creds = () => fd({ email: "tech@example.com", password: "hunter2hunter2" });

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitStateForTests();
  extraHeaders.current = {};
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetRateLimitStateForTests();
});

describe("loginAction rate limiting", () => {
  it("refuses the 6th failed sign-in from one network, and says how long", async () => {
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      const res = await loginAction(undefined, creds());
      expect(res, `attempt ${i + 1}`).toEqual({ error: "Invalid email or password." });
    }

    const blocked = await loginAction(undefined, creds());
    expect(blocked?.error).toMatch(/Too many attempts from this network/);
    expect(blocked?.error).toMatch(/minutes/);
  });

  it("refuses BEFORE calling signIn, so a locked-out attacker costs no bcrypt", async () => {
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) await loginAction(undefined, creds());
    const callsBefore = signIn.mock.calls.length;

    await loginAction(undefined, creds());
    expect(signIn.mock.calls.length).toBe(callsBefore);
  });

  it("spends the token BEFORE the password check, not after it fails", async () => {
    // The TOCTOU this closes: charging only on failure leaves a window exactly
    // as wide as the bcrypt compare, so N concurrent POSTs all read an
    // untouched bucket and all get a guess. Modelled here by never letting
    // `signIn` settle — every attempt is still in flight, so if the token were
    // spent afterwards the bucket would still be full.
    let pendingSignIns = 0;
    signIn.mockImplementation(() => {
      pendingSignIns++;
      return new Promise(() => {}); // never resolves
    });

    const inFlight = Array.from({ length: AUTH_POLICY.limit }, () =>
      loginAction(undefined, creds()),
    );
    // Let each attempt work through its awaits and reach the never-settling
    // signIn call. Several ticks, because the limiter and the Turnstile check
    // in front of it are each async.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(pendingSignIns).toBe(AUTH_POLICY.limit);

    // The budget is already gone, even though not one attempt has completed.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    const blocked = await loginAction(undefined, creds());
    expect(blocked?.error).toMatch(/Too many attempts from this network/);
    expect(inFlight).toHaveLength(AUTH_POLICY.limit);
  });

  it("REFUNDS the token when the sign-in succeeds", async () => {
    // The load-bearing property: the service desk shares one NAT egress IP, so
    // charging successes would take the whole desk offline after five logins.
    // With `redirect: false`, success is a RETURNED destination and the action
    // redirects to it itself.
    signIn.mockResolvedValue("http://localhost/items");

    for (let i = 0; i < AUTH_POLICY.limit * 4; i++) {
      await expect(loginAction(undefined, creds())).rejects.toThrow("NEXT_REDIRECT");
    }

    // The budget is back, so a genuine typo still gets its full five tries.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect(await loginAction(undefined, creds()), `try ${i + 1}`).toEqual({
        error: "Invalid email or password.",
      });
    }
  });

  it("treats a RETURNED error URL as a failed attempt, not a success", async () => {
    // @auth/core can hand back `?error=CredentialsSignin` instead of throwing —
    // that is exactly what the `X-Auth-Return-Redirect` header provokes. Reading
    // it as success would refund the token and skip the detector.
    signIn.mockResolvedValue("http://localhost/login?error=CredentialsSignin&code=credentials");
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect(await loginAction(undefined, creds()), `try ${i + 1}`).toEqual({
        error: "Invalid email or password.",
      });
    }
    const blocked = await loginAction(undefined, creds());
    expect(blocked?.error).toMatch(/Too many attempts/);
  });

  it("does NOT refund on an unexpected server error", async () => {
    // A crash is not evidence the credentials were right. Refunding on any
    // non-AuthError throw would make "provoke an exception" a free retry loop.
    // Returned as a generic form error, NOT re-thrown: with `redirect: false`
    // there is no NEXT_REDIRECT left for signIn to raise, so a rethrow would
    // only escalate a transient DB blip to the error boundary and replace the
    // form with a digest.
    signIn.mockRejectedValue(new Error("database on fire"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect(await loginAction(undefined, creds()), `try ${i + 1}`).toEqual({
        error: "Something went wrong. Please try again.",
      });
    }
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    const blocked = await loginAction(undefined, creds());
    expect(blocked?.error).toMatch(/Too many attempts from this network/);
  });

  it("keeps the generic failure message — the limiter must not leak account state", async () => {
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    const res = await loginAction(undefined, creds());
    expect(res).toEqual({ error: "Invalid email or password." });
  });

  it("refuses a request carrying X-Auth-Return-Redirect, and charges it", async () => {
    // `signIn()` copies the incoming request headers into the request it hands
    // to @auth/core, which treats this header as "return the error instead of
    // throwing it". A wrong password then arrives here as a NEXT_REDIRECT —
    // indistinguishable from success — so the attempt would be refunded and
    // never counted by the botnet detector. One header, unlimited guessing.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    extraHeaders.current = { "x-auth-return-redirect": "1" };

    const res = await loginAction(undefined, creds());
    expect(res).toEqual({ error: "Invalid email or password." });
    // Refused before the password check, not merely tolerated afterwards.
    expect(signIn).not.toHaveBeenCalled();

    // …and it still cost a token, so probing is not cheaper than guessing.
    expect(
      __memoryHitCountForTests(
        rateLimitKey(AUTH_POLICY, TEST_IP, "login", await rateLimitIdentity("tech@example.com")),
      ),
    ).toBe(1);
  });

  it("does NOT wipe an account's failure count when the shared ceiling refuses", async () => {
    // `resetRateLimit` empties a bucket rather than decrementing it, so handing
    // the narrow token "back" when the ceiling refuses is a bypass: saturate the
    // ceiling with throwaway addresses and every subsequent attempt against a
    // real account clears that account's counter, lifting the effective
    // per-account guess rate from 5 to the ceiling.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    const victim = "alice@example.com";
    const victimKey = rateLimitKey(
      AUTH_POLICY,
      TEST_IP,
      "login",
      await rateLimitIdentity(victim),
    );

    // Two real guesses at the victim, then saturate the shared ceiling.
    await loginAction(undefined, fd({ email: victim, password: "wrong" }));
    await loginAction(undefined, fd({ email: victim, password: "wrong" }));
    expect(__memoryHitCountForTests(victimKey)).toBe(2);

    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      await loginAction(undefined, fd({ email: `filler${i}@example.com`, password: "x" }));
    }

    // Now ceiling-refused. The victim's count must not be reset by it.
    const blocked = await loginAction(undefined, fd({ email: victim, password: "wrong" }));
    expect(blocked?.error).toMatch(/Too many attempts/);
    expect(__memoryHitCountForTests(victimKey)).toBeGreaterThanOrEqual(2);
  });

  it("does not let one person's typos lock out a colleague on the same network", async () => {
    // Every request in this file carries the SAME IP. A purely per-IP limiter
    // would refuse the second account after the first burned five tries — which
    // is the real failure mode for a service desk behind one NAT egress.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      await loginAction(undefined, fd({ email: "alice@example.com", password: "wrong" }));
    }
    expect(
      (await loginAction(undefined, fd({ email: "alice@example.com", password: "wrong" })))?.error,
    ).toMatch(/Too many attempts/);

    const bob = await loginAction(undefined, fd({ email: "bob@example.com", password: "wrong" }));
    expect(bob).toEqual({ error: "Invalid email or password." });
  });

  it("treats one account case-insensitively, so capitalisation is not a fresh budget", async () => {
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      await loginAction(undefined, fd({ email: "alice@example.com", password: "wrong" }));
    }
    const shouted = await loginAction(
      undefined,
      fd({ email: "  ALICE@Example.COM ", password: "wrong" }),
    );
    expect(shouted?.error).toMatch(/Too many attempts/);
  });

  it("does NOT let one hammered account drain the whole network's ceiling", async () => {
    // The ordering bug this pins: charging the shared per-network ceiling
    // BEFORE the per-account bucket meant 60 cheap requests naming one address
    // — 55 of them refused by the narrow bucket and still charged — locked
    // every colleague behind that egress out of sign-in for 15 minutes. Which
    // is precisely the failure the composite key exists to prevent.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit * 2; i++) {
      await loginAction(undefined, fd({ email: "alice@example.com", password: "wrong" }));
    }
    const bob = await loginAction(undefined, fd({ email: "bob@example.com", password: "wrong" }));
    expect(bob).toEqual({ error: "Invalid email or password." });
  });

  it("does NOT refund the SHARED ceiling on a successful sign-in", async () => {
    // Refunding it would let anyone holding one valid credential clear the
    // whole network's counter between guesses — 5 tries each against an
    // unlimited number of accounts, which is the ceiling doing nothing.

    // Spend most of the ceiling on distinct accounts...
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit - 1; i++) {
      await loginAction(undefined, fd({ email: `v${i}@example.com`, password: "wrong" }));
    }
    // ...then sign in correctly, which must NOT hand the ceiling back...
    signIn.mockResolvedValue("http://localhost/items");
    await expect(
      loginAction(undefined, fd({ email: "real@example.com", password: "right" })),
    ).rejects.toThrow("NEXT_REDIRECT");

    // ...so the next fresh account is refused by the ceiling.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    const blocked = await loginAction(undefined, fd({ email: "next@example.com", password: "x" }));
    expect(blocked?.error).toMatch(/Too many attempts/);
  });

  it("stops a spray across many accounts from one network", async () => {
    // The per-account bucket is keyed on attacker-supplied input, so on its own
    // rotating the email would mint a fresh five tries forever. The per-IP
    // ceiling is what closes that.
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      const res = await loginAction(
        undefined,
        fd({ email: `victim${i}@example.com`, password: "wrong" }),
      );
      expect(res, `victim ${i + 1}`).toEqual({ error: "Invalid email or password." });
    }
    const blocked = await loginAction(
      undefined,
      fd({ email: "victim-last@example.com", password: "wrong" }),
    );
    expect(blocked?.error).toMatch(/Too many attempts/);
  });
});

describe("resetPasswordAction rate limiting", () => {
  const submission = (token: string) =>
    fd({ token, password: "new-password-123", confirm: "new-password-123" });

  it("throttles repeated guesses at ONE token", async () => {
    // Keyed on the token now, not just the network — so hammering a single
    // token is capped at five while a colleague with a different (valid) link
    // is unaffected. See the network-ceiling test below for the other half.
    resetPasswordWithToken.mockResolvedValue(false);
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      const res = await resetPasswordAction(undefined, submission("one-token"));
      expect(res).toEqual({ error: "This reset link is invalid or has expired." });
    }
    const blocked = await resetPasswordAction(undefined, submission("one-token"));
    expect("error" in blocked && blocked.error).toMatch(/Too many attempts from this network/);
  });

  it("does not let one dead link lock out someone holding a valid one", async () => {
    // Five colleagues clicking yesterday's expired links used to lock out the
    // sixth, who was holding a perfectly good link, because the bucket was the
    // whole network.
    resetPasswordWithToken.mockResolvedValue(false);
    for (let i = 0; i < AUTH_POLICY.limit + 1; i++) {
      await resetPasswordAction(undefined, submission("stale-token"));
    }
    resetPasswordWithToken.mockResolvedValue(true);
    expect(await resetPasswordAction(undefined, submission("fresh-token"))).toEqual({ ok: true });
  });

  it("still caps a walk through many tokens from one network", async () => {
    resetPasswordWithToken.mockResolvedValue(false);
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      await resetPasswordAction(undefined, submission(`guess-${i}`));
    }
    const blocked = await resetPasswordAction(undefined, submission("guess-final"));
    expect("error" in blocked && blocked.error).toMatch(/Too many attempts from this network/);
  });

  it("does not charge a mistyped confirmation, which never reached the token", async () => {
    for (let i = 0; i < AUTH_POLICY.limit * 2; i++) {
      const res = await resetPasswordAction(
        undefined,
        fd({ token: "t", password: "new-password-123", confirm: "different-password" }),
      );
      expect(res).toEqual({ error: "Passwords do not match." });
    }
    expect(resetPasswordWithToken).not.toHaveBeenCalled();

    resetPasswordWithToken.mockResolvedValue(true);
    expect(await resetPasswordAction(undefined, submission("good"))).toEqual({ ok: true });
  });

  it("does NOT refund a successful reset, because the token is spent anyway", async () => {
    // The bucket is keyed on the token hash and a successful reset CONSUMES the
    // token, so freed attempts could never be spent by anyone — the refund
    // bought nothing and cost the O(keyspace) Redis SCAN that resetRateLimit
    // warns about. Five goes at one token is all anybody needs.
    resetPasswordWithToken.mockResolvedValue(true);
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect(await resetPasswordAction(undefined, submission("good")), `try ${i + 1}`)
        .toEqual({ ok: true });
    }
    const blocked = await resetPasswordAction(undefined, submission("good"));
    expect("error" in blocked && blocked.error).toMatch(/Too many attempts from this network/);
  });

  it("keeps the token spent when the reset THROWS", async () => {
    // Not a bad token, but not a success either. Refunding here would make any
    // input that reliably provokes an exception an unmetered retry loop.
    resetPasswordWithToken.mockRejectedValue(new Error("database on fire"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect(await resetPasswordAction(undefined, submission("boom"))).toEqual({
        error: "Something went wrong. Please try again.",
      });
    }
    const blocked = await resetPasswordAction(undefined, submission("boom"));
    expect("error" in blocked && blocked.error).toMatch(/Too many attempts from this network/);
  });
});

describe("requestPasswordResetAction rate limiting", () => {
  const resetKey = async (email: string) =>
    rateLimitKey(AUTH_POLICY, TEST_IP, "reset-request", await rateLimitIdentity(email));

  it("throttles the SIXTH request for one address, and stays account-agnostic", async () => {
    // Charged on EVERY call, not only failures: the abuse here is volume
    // (mail-bombing a known address), and there is no "failed attempt" to key
    // on. The refusal is IP-shaped — identical for a registered and an
    // unregistered address — so it says nothing the generic success did not.
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      expect(
        await requestPasswordResetAction(undefined, fd({ email: "target@example.com" })),
        `request ${i + 1}`,
      ).toEqual({ ok: true });
    }
    const scheduled = after.mock.calls.length;

    const blocked = await requestPasswordResetAction(
      undefined,
      fd({ email: "target@example.com" }),
    );
    expect("error" in blocked ? blocked.error : "").toMatch(/Too many attempts from this network/);
    // No deferred lookup or email for a throttled call.
    expect(after.mock.calls.length).toBe(scheduled);

    // A DIFFERENT address, still throttled by the shared per-network ceiling,
    // must produce the byte-identical refusal — otherwise the throttle becomes
    // a new oracle for "does this account exist". (The previous version of this
    // test re-sent the SAME address and asserted nothing at all.)
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      await requestPasswordResetAction(undefined, fd({ email: `filler${i}@example.com` }));
    }
    const unknown = await requestPasswordResetAction(
      undefined,
      fd({ email: "definitely-not-registered@example.com" }),
    );
    expect(unknown).toEqual(blocked);
  });

  it("does not let one address's budget block a different one", async () => {
    // The composite key again: mail-bombing one inbox must not stop a colleague
    // behind the same connection from resetting their own password.
    for (let i = 0; i < AUTH_POLICY.limit + 1; i++) {
      await requestPasswordResetAction(undefined, fd({ email: "target@example.com" }));
    }
    expect(await requestPasswordResetAction(undefined, fd({ email: "other@example.com" })))
      .toEqual({ ok: true });
  });

  it("still stops a walk through a list of addresses from one network", async () => {
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit; i++) {
      expect(
        await requestPasswordResetAction(undefined, fd({ email: `probe${i}@example.com` })),
        `probe ${i + 1}`,
      ).toEqual({ ok: true });
    }
    const blocked = await requestPasswordResetAction(undefined, fd({ email: "probe@example.com" }));
    expect("error" in blocked ? blocked.error : "").toMatch(/Too many attempts from this network/);
  });

  it("does not charge a malformed email, which never reached the account lookup", async () => {
    for (let i = 0; i < AUTH_POLICY.limit * 2; i++) {
      expect(await requestPasswordResetAction(undefined, fd({ email: "not-an-email" }))).toEqual({
        error: "Enter a valid email address.",
      });
    }
    expect(await requestPasswordResetAction(undefined, fd({ email: "real@example.com" }))).toEqual({
      ok: true,
    });
  });

  it("spends the token BEFORE scheduling the deferred send", async () => {
    // Ordering matters for anti-enumeration: the account lookup runs inside
    // `after()`, so a limiter placed after it would have to know the outcome,
    // and the response would stop being constant-time.
    const key = await resetKey("real@example.com");
    let hitsWhenScheduled = -1;
    after.mockImplementation(() => {
      hitsWhenScheduled = __memoryHitCountForTests(key);
    });

    await requestPasswordResetAction(undefined, fd({ email: "real@example.com" }));
    expect(after).toHaveBeenCalledTimes(1);
    expect(hitsWhenScheduled).toBe(1);
  });
});
