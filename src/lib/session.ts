import "server-only";
import { cache } from "react";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { effectiveCapabilities } from "@/modules/users/capabilities";

// Per-request memoized session + current user. `cache` dedupes across every
// server component in one render (e.g. a page AND the SiteHeader it renders),
// so `auth()` is decoded once and the user row is fetched at most once.
export const getSession = cache(() => auth());

// The session's JWT `role` is captured at login and can go stale (e.g. an admin
// gets demoted). Re-read role/isActive from the DB so nav + gating reflect the
// current state. Returns null for anonymous visitors WITHOUT a DB hit.
//
// `capabilities` is the resolved effective set, produced by the SAME pure
// function requireCapability's session read uses — so what the nav offers and
// what the server actually permits cannot drift. This is for RENDERING
// decisions only. It is not an authorization boundary: that stays per-route in
// requireCapability/requireAdmin, which re-read from the DB themselves.
export const getCurrentUser = cache(async () => {
  const session = await getSession();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      capabilities: { select: { capability: true } },
    },
  });
  if (!user) return null;
  const { capabilities, ...rest } = user;
  return {
    ...rest,
    capabilities: effectiveCapabilities(
      user.role,
      capabilities.map((c) => c.capability),
    ),
  };
});
