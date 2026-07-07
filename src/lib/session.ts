import "server-only";
import { cache } from "react";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";

// Per-request memoized session + current user. `cache` dedupes across every
// server component in one render (e.g. a page AND the SiteHeader it renders),
// so `auth()` is decoded once and the user row is fetched at most once.
export const getSession = cache(() => auth());

// The session's JWT `role` is captured at login and can go stale (e.g. an admin
// gets demoted). Re-read role/isActive from the DB so nav + gating reflect the
// current state. Returns null for anonymous visitors WITHOUT a DB hit.
export const getCurrentUser = cache(async () => {
  const session = await getSession();
  const id = session?.user?.id;
  if (!id) return null;
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
});
