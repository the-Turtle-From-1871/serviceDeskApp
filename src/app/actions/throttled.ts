import { formatRetryAfter } from "@/lib/rate-limit";

/**
 * The one wording every rate-limited Server Action returns.
 *
 * Its own module because both `auth.ts` and `unlock.ts` need it and neither
 * should import the other: `unlock.ts` is the public PIN gate and must not pull
 * in the sign-in graph. It was hand-copied between the two, which is how the
 * refusal a user sees starts depending on which form they happened to submit.
 *
 * "from this network" is load-bearing, not flavour — the buckets are keyed on
 * IP, so a colleague's attempts really can be what refused you, and a message
 * saying "you have tried too many times" would be a lie on a shared egress.
 */
export const THROTTLED = (retryAfterSeconds: number) => ({
  error: `Too many attempts from this network. Try again ${formatRetryAfter(retryAfterSeconds)}.`,
});
