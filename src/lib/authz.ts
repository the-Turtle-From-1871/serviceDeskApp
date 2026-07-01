import type { Role } from "@prisma/client";

export type SessionUser = { id: string; role: Role; name: string; email: string };

export class AuthError extends Error {
  constructor(public code: "UNAUTHENTICATED" | "FORBIDDEN") {
    super(code);
    this.name = "AuthError";
  }
}

type GetSession = () => Promise<{ user: SessionUser } | null>;

// Loaded lazily (rather than as a static top-level import) so that unit
// tests injecting a fake `getSession` never pull in `@/auth` (and its
// next-auth -> next/server import chain, which Vitest cannot resolve
// outside a real Next.js build).
//
// This is also where session freshness is enforced: the JWT only carries the
// role captured at login, so here we re-read role + isActive from the DB. That
// makes role changes and deactivations take effect on the next request instead
// of living stale until the token expires. It runs only in Node server
// functions (Server Components / Actions / Route Handlers) that call
// requireUser/requireAdmin — never in the edge-deployable proxy — which is the
// pattern Next recommends: enforce authz in the server function, not the proxy.
const defaultGetSession: GetSession = async () => {
  const { auth } = await import("@/auth");
  const session = await auth();
  if (!session?.user) return null;
  const { default: prisma } = await import("@/lib/prisma");
  const fresh = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, isActive: true },
  });
  if (!fresh || !fresh.isActive) return null;
  return { user: { ...session.user, role: fresh.role } };
};

export async function requireUser(
  getSession: GetSession = defaultGetSession
): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.user) throw new AuthError("UNAUTHENTICATED");
  return session.user;
}

export async function requireAdmin(
  getSession: GetSession = defaultGetSession
): Promise<SessionUser> {
  const user = await requireUser(getSession);
  if (user.role !== "ADMIN") throw new AuthError("FORBIDDEN");
  return user;
}
