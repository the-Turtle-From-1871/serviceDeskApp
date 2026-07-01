import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/password";

const credsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
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
      if (user) token.id = user.id;
      if (!token.id) return token;
      // Re-read role + isActive from the DB on every request (this callback
      // runs whenever the session is validated, including in `proxy`, which
      // Next 16 runs on the Node runtime — so Prisma is available here). This
      // makes role changes and deactivations take effect immediately instead
      // of living stale in the JWT until it expires. Returning null clears the
      // session cookies (Auth.js v5), effectively signing the user out.
      const dbUser = await prisma.user.findUnique({
        where: { id: token.id },
        select: { role: true, isActive: true },
      });
      if (!dbUser || !dbUser.isActive) return null;
      token.role = dbUser.role;
      return token;
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
