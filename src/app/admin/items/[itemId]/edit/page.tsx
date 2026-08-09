import { notFound, redirect } from "next/navigation";
import { getItem, listItemFieldSuggestions } from "@/modules/items/items.service";
import { listCategoryNames } from "@/modules/items/categories.service";
import { listUnits } from "@/modules/items/units.service";
import { requireCapability, AuthError } from "@/lib/authz";
import { StatusBadge } from "@/components/StatusBadge";
import { EditItemForm } from "./EditItemForm";
import { EditItemIdentityForm } from "./EditItemIdentityForm";

export default async function EditItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  try {
    await requireCapability("MANAGE_ITEMS");
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }
  const { itemId } = await params;
  // The picker offers the MANAGED vocabulary, not whatever strings happen to
  // be on items — that is the point of curating the list.
  const [item, categories, units, suggestions] = await Promise.all([
    getItem(itemId),
    listCategoryNames(),
    listUnits(),
    listItemFieldSuggestions(),
  ]);
  if (!item) notFound();
  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Edit item</h1>
          {/* Identification line. Make/model/serial are correctable, but only
              through the separate identity form below — never from the item
              detail card, and never as part of the eight-field form. */}
          <p className="subtle">{item.make} {item.model} · SN {item.serialNumber}</p>
        </div>
        <span className="spacer" />
        <StatusBadge status={item.status} />
      </div>
      <EditItemForm item={item} categories={categories} units={units.map((u) => u.fullName)} suggestions={suggestions} />
      <EditItemIdentityForm item={item} suggestions={suggestions} />
    </div>
  );
}
