import Link from "next/link";
import { auth } from "@/auth";
import { HomeSearch } from "@/components/HomeSearch";
import { SignOutButton } from "@/components/SignOutButton";

export default async function HomePage() {
  const session = await auth();
  const isAdmin = session?.user?.role === "ADMIN";
  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          {session?.user ? (
            <>
              <Link href="/items" className="btn btn-ghost btn-sm">Items</Link>
              {isAdmin && <Link href="/admin/users" className="btn btn-ghost btn-sm">Admin</Link>}
              <SignOutButton />
            </>
          ) : (
            <Link href="/login" className="btn btn-ghost btn-sm">Staff sign in</Link>
          )}
        </div>
      </header>
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
