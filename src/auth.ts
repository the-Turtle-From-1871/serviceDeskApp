import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

const credsSchema = z.object({
  email: z.string().trim().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Trust the host header behind a platform proxy (e.g. Vercel) so Auth.js
  // does not reject requests with UntrustedHost in production.
  trustHost: true,
  session: { strategy: "jwt" },
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

      // Subsequent calls (every auth() invocation, incl. proxy/middleware):
      // re-check the DB stamp so a password reset revokes already-issued JWTs.
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
    // Required so that `auth` used as `proxy` actually redirects unauthenticated
    // requests to `pages.signIn` for every matched route, instead of merely
    // attaching `req.auth` without enforcing anything.
    authorized({ auth }) {
      return !!auth;
    },
  },
});
