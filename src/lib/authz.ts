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
const defaultGetSession: GetSession = async () => {
  const { auth } = await import("@/auth");
  return auth();
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
