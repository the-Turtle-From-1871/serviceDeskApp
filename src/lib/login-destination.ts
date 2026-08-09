/**
 * Where a successful sign-in lands.
 *
 * Shared because BOTH halves of the sign-in now name it: `loginAction` passes it
 * to `signIn()` as `redirectTo`, and `LoginForm` navigates to it itself once the
 * action reports success (see the comment on that action's success path for why
 * the client performs the navigation rather than the server).
 *
 * Keeping it in one place is not tidiness — it is what stops the client
 * navigating somewhere the session was never issued for. It lives in its own
 * leaf module because `auth.ts` is a `"use server"` file, and every export from
 * one of those must be an async function, so the constant cannot live beside the
 * action that uses it.
 */
export const LOGIN_DESTINATION = "/items";
