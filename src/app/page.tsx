import Link from "next/link";
import { auth } from "@/auth";
import { HomeSearch } from "@/components/HomeSearch";
import { SignOutButton } from "@/components/SignOutButton";
import { AppHeader } from "@/components/AppHeader";

export default async function HomePage() {
  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";
  return (
    <>
      <AppHeader brandHref="/">
        {session?.user ? (
          <>
            <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
            {isAdmin && <Link href="/admin/users" className="btn btn-ghost btn-sm">Admin</Link>}
            <SignOutButton />
          </>
        ) : (
          <Link href="/login" className="btn btn-ghost btn-sm">Staff sign in</Link>
        )}
      </AppHeader>
      <main className="container container-mid stack">
        <div>
          <h1 className="page-title">Find an item or hand receipt</h1>
          <p className="subtle">Search by item serial number, or look up a hand receipt by its number (HR-XXXXXX).</p>
        </div>
        <HomeSearch />
      </main>
    </>
  );
}
