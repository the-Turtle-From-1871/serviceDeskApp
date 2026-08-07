import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";
import {
  SESSION_MAX_AGE_SECONDS,
  sessionFreshness,
} from "@/lib/session-freshness";

const credsSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Trust the host header behind a platform proxy (e.g. Vercel) so Auth.js
  // does not reject requests with UntrustedHost in production.
  trustHost: true,
  // 30 days. This bounds the cookie and the JWT's own `exp`, but it ROLLS —
  // Auth.js re-signs the token with a fresh expiry on every `auth()` call — so
  // on its own it is an idle timeout, not an absolute one. The absolute bound
  // and the 7-day idle cut-off are the `authAt`/`lastActiveAt` claims enforced
  // in the `jwt` callback below. It must never be shorter than the absolute
  // bound, or the cookie would expire before the claim it is supposed to carry;
  // reading the same constant is what guarantees that. See
  // `src/lib/session-freshness.ts`.
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (raw) => {
        const parsed = credsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.isActive) return null;
        if (!(await verifyPassword(password, user.passwordHash))) return null;
        return { id: user.id, name: user.name, email: user.email, role: user.role };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // Sign-in: seed identity + a "password freshness" claim from the DB.
      // This one extra read happens only at login.
      if (user) {
        token.id = user.id;
        token.role = user.role;
        // Start of the absolute window. `authAt` is never moved again — that is
        // what makes the absolute bound absolute.
        token.authAt = Date.now();
        token.lastActiveAt = token.authAt;
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { passwordChangedAt: true },
          });
          token.pwdChangedAt = dbUser?.passwordChangedAt?.getTime() ?? null;
        } catch (err) {
          // Fail-open: a transient DB blip at login should not break sign-in.
          console.error("jwt callback: failed to seed pwdChangedAt", err);
        }
        return token;
      }

      // Subsequent calls (every auth() invocation, incl. proxy/middleware).
      //
      // Freshness FIRST, because it is free: an expired session should not cost
      // a database round trip. Revoking returns null, so the session no longer
      // satisfies `!!req.auth` and the coarse gate in `src/proxy.ts` redirects
      // to /login — i.e. it forces re-authentication, which is what the
      // requirement asks middleware to do.
      //
      // ENFORCEMENT lives here rather than in the proxy because this callback
      // runs on EVERY `auth()` call — Server Actions, Route Handlers and RSC
      // included, not only the routes the proxy matcher covers. A proxy-only
      // check would leave a 9-hour-idle session able to POST a Server Action.
      //
      // The WRITE, however, does ride the proxy, and that asymmetry is worth
      // knowing: only the middleware/route-handler wrapper copies the session
      // action's `Set-Cookie` onto the response (`handleAuth` in
      // `next-auth/lib/index.js`). The bare `auth()` used by RSC and
      // `requireUser` re-signs a token and discards it. So `lastActiveAt`
      // advances because `src/proxy.ts` ran for the same request — which makes
      // its MATCHER load-bearing for the idle clock. Every authenticated
      // surface is matched today; excluding one would leave users working there
      // bounced one idle window after their last *matched* request. (The
      // matcher's exclusions are metadata routes — favicon, manifest, app icons
      // — which nobody navigates to, so no user's clock rides on them.)
      const now = Date.now();
      const freshness = sessionFreshness(
        {
          authAt: token.authAt,
          lastActiveAt: token.lastActiveAt,
          // `iat` is seconds; it is re-stamped on every roll, so it is "when
          // this token was last legitimately used" — the right basis for
          // backfilling a pre-deploy token. See session-freshness.ts.
          issuedAtMs: typeof token.iat === "number" ? token.iat * 1000 : null,
        },
        now,
      );
      if (freshness.action === "revoke") return null;
      // `authAt` comes back unchanged for a normal request and backfilled for a
      // token minted before these claims existed — never recomputed from `now`.
      token.authAt = freshness.authAt;
      token.lastActiveAt = now;

      // Re-check the DB stamp so a password reset revokes already-issued JWTs.
      try {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id },
          select: { passwordChangedAt: true },
        });

        // Account deleted -> revoke.
        if (!dbUser) return null;

        const dbStamp = dbUser.passwordChangedAt?.getTime() ?? null;

        // Grandfather tokens issued before this claim existed: seed, don't revoke.
        if (token.pwdChangedAt === undefined) {
          token.pwdChangedAt = dbStamp;
          return token;
        }

        // Password changed after this token was issued -> revoke.
        if (
          dbStamp !== null &&
          (token.pwdChangedAt === null || dbStamp > token.pwdChangedAt)
        ) {
          return null;
        }

        return token;
      } catch (err) {
        // Fail-open: do not lock everyone out on a transient DB error.
        console.error("jwt callback: freshness check failed", err);
        return token;
      }
    },
    session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      return session;
    },
    // `src/proxy.ts` uses the functional `auth(async (req) => {...})` form and
    // performs its own `/login` and `/unlock` redirects, so this declarative
    // `authorized` callback is not the active enforcement path for the proxy.
    // Retained as a harmless default / for any future declarative `export {
    // auth as proxy }` use.
    authorized({ auth }) {
      return !!auth;
    },
  },
});
