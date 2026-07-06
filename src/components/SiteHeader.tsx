import { auth } from "@/auth";
import { AppHeader } from "@/components/AppHeader";
import { navItemsFor } from "@/components/nav";

export async function SiteHeader() {
  const session = await auth();
  const loggedIn = !!session?.user;
  const isAdmin = session?.user?.role === "ADMIN";
  return <AppHeader items={navItemsFor({ loggedIn, isAdmin })} loggedIn={loggedIn} />;
}
