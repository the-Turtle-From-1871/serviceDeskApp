import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_VELOCITY_POLICY,
  __resetAuthVelocityStateForTests,
  authVelocityElevated,
  recordAuthFailure,
} from "./auth-velocity";
import { __resetRateLimitStateForTests } from "./rate-limit";

beforeEach(() => {
  __resetRateLimitStateForTests();
  __resetAuthVelocityStateForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetRateLimitStateForTests();
  __resetAuthVelocityStateForTests();
});

/** Sign-in failures — the only surface that may raise the escalation. */
const failures = (n: number) => Array.from({ length: n }, () => recordAuthFailure("login"));
/** Any other guessable surface: counted for the ALERT, never for the escalation. */
const otherFailures = (n: number) => Array.from({ length: n }, () => recordAuthFailure("other"));

describe("the threshold", () => {
  it("is a whole-application rate, not a per-caller budget", () => {
    // Literals as an independent oracle. If this were per-IP it would be
    // redundant with AUTH_POLICY; the point is that it is the one counter a
    // distributed attacker cannot spread out of.
    expect(AUTH_VELOCITY_POLICY.limit).toBe(100);
    expect(AUTH_VELOCITY_POLICY.windowSeconds).toBe(5 * 60);
  });
});

describe("recordAuthFailure", () => {
  it("stays quiet through a normal day's worth of typos", async () => {
    for (const elevated of await Promise.all(failures(AUTH_VELOCITY_POLICY.limit - 1))) {
      expect(elevated).toBe(false);
    }
    expect(await authVelocityElevated()).toBe(false);
  });

  it("reports elevated once the app-wide rate reaches the threshold", async () => {
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit - 1));
    expect(await recordAuthFailure("login")).toBe(true);
    expect(await authVelocityElevated()).toBe(true);
  });

  it("agrees with itself about when the state starts", async () => {
    // Two functions naming one state must flip on the same attempt. An
    // off-by-one here is invisible in normal operation and wrong exactly when
    // it matters.
    // Sign-in failures throughout, so the alert bucket and the escalation
    // bucket cross on the same attempt and the two answers stay comparable.
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit - 2));
    expect(await authVelocityElevated()).toBe(false);
    expect(await recordAuthFailure("login")).toBe(false);
    expect(await authVelocityElevated()).toBe(false);
    expect(await recordAuthFailure("login")).toBe(true);
    expect(await authVelocityElevated()).toBe(true);
  });

  it("catches an attack that every per-IP bucket would miss", async () => {
    // The whole reason this exists: 10,000 hosts making 4 attempts each never
    // trip a 5-per-IP limit, but the aggregate is unmistakable. Modelled here
    // as failures arriving with no per-caller identity at all — the global
    // counter does not care where they came from.
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit + 1));
    expect(await authVelocityElevated()).toBe(true);
  });

  it("clears on its own once the failures stop", async () => {
    // No separate expiry to maintain: the window slides and the state lapses.
    // Without this an attack would leave the app permanently strict.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:00:00Z"));
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit + 1));
    expect(await authVelocityElevated()).toBe(true);

    vi.advanceTimersByTime(AUTH_VELOCITY_POLICY.windowSeconds * 1000 + 1_000);
    expect(await authVelocityElevated()).toBe(false);
  });

  it("logs one structured alert, not one per attempt", async () => {
    // The alarm must not become the flood: at 20 failures/second an unthrottled
    // alert line is its own denial of service on the log drain.
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit - 1));
    (console.error as unknown as { mockClear: () => void }).mockClear();

    for (let i = 0; i < 50; i++) await recordAuthFailure();
    expect(console.error).toHaveBeenCalledTimes(1);

    const [line] = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0];
    expect(JSON.parse(line)).toMatchObject({ event: "auth.velocity.elevated" });
  });

  it("alerts again after the cooldown, so a continuing attack keeps saying so", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:00:00Z"));
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit + 1));
    (console.error as unknown as { mockClear: () => void }).mockClear();

    vi.advanceTimersByTime(61_000);
    await recordAuthFailure();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe("the alert / escalation split", () => {
  it("counts every surface toward the ALERT", async () => {
    // Broad on purpose: a blind spot costs the whole point of the feature, and
    // a false alarm costs a log line.
    await Promise.all(otherFailures(AUTH_VELOCITY_POLICY.limit - 1));
    expect(await recordAuthFailure("other")).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("does NOT let /unlock or a bad reset token raise the ESCALATION", async () => {
    // The load-bearing property. `/unlock` needs no account and carries no
    // challenge of its own, so if it could flip Turnstile to strict an
    // unauthenticated attacker would have a cheap global switch: fill the
    // bucket and every sign-in whose verification is `unreachable` is refused
    // app-wide. That is the detector becoming the vulnerability.
    await Promise.all(otherFailures(AUTH_VELOCITY_POLICY.limit * 3));
    expect(await authVelocityElevated()).toBe(false);
  });

  it("still escalates on sign-in failures", async () => {
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit));
    expect(await authVelocityElevated()).toBe(true);
  });

  it("LATCHES, so the mitigation does not flicker off mid-attack", async () => {
    // Refused hits are deliberately not recorded, so at exactly the threshold
    // the moment the oldest entry ages out `remaining` becomes 1 and an
    // unlatched check would report NOT elevated until the next failure refills
    // it — waving through roughly half the submissions it exists to refuse.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T09:00:00Z"));
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit));
    expect(await authVelocityElevated()).toBe(true);

    // Most of a window later, with nothing new recorded, it must still hold.
    vi.advanceTimersByTime(AUTH_VELOCITY_POLICY.windowSeconds * 1000 - 1_000);
    expect(await authVelocityElevated()).toBe(true);

    // …and still lapse on its own once the window is genuinely past.
    vi.advanceTimersByTime(2_000);
    expect(await authVelocityElevated()).toBe(false);
  });
});

describe("authVelocityElevated", () => {
  it("does not itself count as a failure", async () => {
    // It is read-only. If reading the state spent from the bucket, merely
    // checking often enough would raise the alarm.
    for (let i = 0; i < AUTH_VELOCITY_POLICY.limit * 2; i++) {
      expect(await authVelocityElevated()).toBe(false);
    }
  });

  it("reports NOT elevated when the store is unavailable", async () => {
    // Fails open on purpose: a Redis outage must not put the app into a
    // stricter mode nobody asked for, on top of the outage.
    vi.stubEnv("RATE_LIMIT_DISABLED", "true");
    await Promise.all(failures(AUTH_VELOCITY_POLICY.limit * 2));
    __resetAuthVelocityStateForTests(); // drop the latch too — the store is the subject
    expect(await authVelocityElevated()).toBe(false);
  });
});
