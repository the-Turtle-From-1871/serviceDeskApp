import "server-only"; // authorization logic is server-only
import type { Capability, Role } from "@prisma/client";
import { effectiveCapabilities } from "@/modules/users/capabilities";

// `capabilities` is the RESOLVED effective set (role baseline ∪ grants), not the
// raw grant rows. Resolving it in exactly one place — defaultGetSession, below —
// means no call site can forget to apply the baseline and so refuse an admin who
// happens to hold no grant rows of their own.
export type SessionUser = {
  id: string;
  role: Role;
  name: string;
  email: string;
  capabilities: Capability[];
};

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
    // Capabilities ride along on the read that ALREADY re-reads role/isActive —
    // one query, no N+1, and a revoked grant dies on the next request exactly
    // as a demotion does. The JWT deliberately never carries capabilities: a
    // token minted before a grant would be stale, and per-request freshness is
    // the entire justification for the 30-day session window.
    select: {
      role: true,
      isActive: true,
      capabilities: { select: { capability: true } },
    },
  });
  if (!fresh || !fresh.isActive) return null;
  return {
    user: {
      ...session.user,
      role: fresh.role,
      capabilities: effectiveCapabilities(
        fresh.role,
        fresh.capabilities.map((c) => c.capability),
      ),
    },
  };
};

export async function requireUser(
  getSession: GetSession = defaultGetSession
): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.user) throw new AuthError("UNAUTHENTICATED");
  return session.user;
}

/**
 * The authorization primitive. Gate on a CAPABILITY — never on a role directly,
 * and never on "the caller happens to own this row": inventory, receipts and the
 * queue are shared org-wide.
 */
export async function requireCapability(
  capability: Capability,
  getSession: GetSession = defaultGetSession
): Promise<SessionUser> {
  const user = await requireUser(getSession);
  if (!user.capabilities.includes(capability)) throw new AuthError("FORBIDDEN");
  return user;
}

/**
 * Kept as the gate for genuinely administrative surfaces — users, audit,
 * contacts, named signatures, the access PIN, receipt timers, seal verification.
 *
 * It is now a THIN ALIAS for the ADMINISTER capability rather than a role check.
 * That is what let the capability model land without editing 29 call sites at
 * once, and it means a granted ADMINISTER works everywhere immediately. Call
 * sites wanting something narrower call requireCapability directly.
 */
export async function requireAdmin(
  getSession: GetSession = defaultGetSession
): Promise<SessionUser> {
  return requireCapability("ADMINISTER", getSession);
}
