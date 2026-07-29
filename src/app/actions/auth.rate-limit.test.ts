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
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": TEST_IP }),
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
    // `signIn` throws NEXT_REDIRECT on success — the action must refund and
    // re-throw it.
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/items;307;",
    });
    signIn.mockRejectedValue(redirectError);

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

  it("does NOT refund on an unexpected server error", async () => {
    // A crash is not evidence the credentials were right. Refunding on any
    // non-AuthError throw would make "provoke an exception" a free retry loop.
    signIn.mockRejectedValue(new Error("database on fire"));
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      await expect(loginAction(undefined, creds())).rejects.toThrow("database on fire");
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
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/items;307;",
    });

    // Spend most of the ceiling on distinct accounts...
    signIn.mockRejectedValue(new AuthError("CredentialsSignin"));
    for (let i = 0; i < AUTH_SPRAY_POLICY.limit - 1; i++) {
      await loginAction(undefined, fd({ email: `v${i}@example.com`, password: "wrong" }));
    }
    // ...then sign in correctly, which must NOT hand the ceiling back...
    signIn.mockRejectedValue(redirectError);
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

  it("throttles token guessing after five bad tokens", async () => {
    resetPasswordWithToken.mockResolvedValue(false);
    for (let i = 0; i < AUTH_POLICY.limit; i++) {
      const res = await resetPasswordAction(undefined, submission(`guess-${i}`));
      expect(res).toEqual({ error: "This reset link is invalid or has expired." });
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

  it("refunds a successful reset", async () => {
    resetPasswordWithToken.mockResolvedValue(true);
    for (let i = 0; i < AUTH_POLICY.limit * 3; i++) {
      expect(await resetPasswordAction(undefined, submission("good"))).toEqual({ ok: true });
    }
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
