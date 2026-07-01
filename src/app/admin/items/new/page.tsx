import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import prisma from "@/lib/prisma";
import { NewItemForm } from "./NewItemForm";

export default async function NewItemPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return (
    <div className="stack">
      <div>
        <h1 className="page-title">New item</h1>
        <p className="subtle">Log a new item and generate its QR code. Optionally assign an initial holder.</p>
      </div>
      <NewItemForm users={users} />
    </div>
  );
}
