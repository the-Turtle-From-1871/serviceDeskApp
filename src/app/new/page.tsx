import Link from "next/link";
import { requireUser } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { listItems } from "@/modules/items/items.service";
import { SignOutButton } from "@/components/SignOutButton";
import { NewTransferForm } from "./NewTransferForm";

export default async function NewTransferPage() {
  const user = await requireUser();
  const items = await listItems();
  const itemOptions = items.map((i) => ({ id: i.id, label: `${i.make} ${i.model} (SN ${i.serialNumber})` }));

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { rank: true, name: true, unit: true, contactNumber: true, email: true, role: true },
  });
  const operator = {
    rank: dbUser?.rank ?? "",
    name: dbUser?.name ?? user.name,
    unit: dbUser?.unit ?? "",
    contact: dbUser?.contactNumber ?? "",
    email: dbUser?.email ?? user.email,
    isAdmin: dbUser?.role === "ADMIN",
  };

  return (
    <>
      <header className="app-header">
        <div className="app-header__inner">
          <Link href="/" className="brand"><span className="brand__mark">HR</span>Hand Receipt</Link>
          <span className="spacer" />
          <span className="subtle">{user.name}</span>
          {operator.isAdmin && <Link href="/admin/items" className="btn btn-ghost btn-sm">Admin</Link>}
          <SignOutButton />
        </div>
      </header>
      <main className="container container-mid stack">
        <h1 className="page-title">New hand receipt</h1>
        <NewTransferForm items={itemOptions} operator={operator} />
      </main>
    </>
  );
}
