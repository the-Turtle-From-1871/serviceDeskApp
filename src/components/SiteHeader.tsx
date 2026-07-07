import { AppHeader } from "@/components/AppHeader";
import { navItemsFor } from "@/components/nav";
import { getCurrentUser } from "@/lib/session";

export async function SiteHeader() {
  // Re-read role/isActive from the DB (via the per-request cache) so the nav
  // reflects the current role, not a possibly-stale JWT.
  const user = await getCurrentUser();
  const loggedIn = !!user && user.isActive;
  const isAdmin = user?.role === "ADMIN";
  return <AppHeader items={navItemsFor({ loggedIn, isAdmin })} loggedIn={loggedIn} />;
}
