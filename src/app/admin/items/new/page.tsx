import { redirect } from "next/navigation";
import Link from "next/link";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listCategoryNames } from "@/modules/items/categories.service";
import { listUnits } from "@/modules/items/units.service";
import { listItemFieldSuggestions } from "@/modules/items/items.service";
import { firstParam } from "@/lib/search-params";
import { NewItemForm } from "./NewItemForm";

export default async function NewItemPage({
  searchParams,
}: {
  // string[] is reachable: Next supplies an array whenever a key is repeated
  // (`?uic=A&uic=B`). firstParam collapses that before any string method runs.
  searchParams: Promise<{ serialNumber?: string | string[]; uic?: string | string[] }>;
}) {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const sp = await searchParams;
  // Arrives from the /items empty state. Inert — it becomes a text input's
  // defaultValue and nothing else; newItemSchema validates it on submit like
  // any other field, including its length bound.
  const prefill = (firstParam(sp.serialNumber) ?? "").trim();
  const returnUic = (firstParam(sp.uic) ?? "").trim();

  const [categories, units, suggestions] = await Promise.all([
    listCategoryNames(),
    listUnits(),
    listItemFieldSuggestions(),
  ]);

  return (
    <div className="stack">
      <div>
        <h1 className="page-title">New item</h1>
        <p className="subtle">Log a new item into inventory.</p>
        <Link href="/admin/items/import" className="btn btn-ghost btn-sm">Import CSV instead</Link>
      </div>
      <NewItemForm
        serialNumber={prefill}
        cameFromSearch={Boolean(prefill)}
        returnUic={returnUic}
        categories={categories}
        units={units.map((u) => u.fullName)}
        suggestions={suggestions}
      />
    </div>
  );
}
