import { notFound, redirect } from "next/navigation";
import { getItem } from "@/modules/items/items.service";
import { requireAdmin, AuthError } from "@/lib/authz";
import { StatusBadge } from "@/components/StatusBadge";
import { EditItemForm } from "./EditItemForm";

export default async function EditItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/dashboard" : "/login");
    throw e;
  }
  const { itemId } = await params;
  const item = await getItem(itemId);
  if (!item) notFound();
  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Edit item</h1>
          <p className="subtle">{item.make} {item.model}</p>
        </div>
        <span className="spacer" />
        <StatusBadge status={item.status} />
      </div>
      <EditItemForm item={item} />
    </div>
  );
}
