import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listCategoriesWithCounts } from "@/modules/items/categories.service";
import { CategoryManager } from "./CategoryManager";

export const metadata = { title: "Device categories" };

/** ADMIN-only: curating the category vocabulary is a privileged capability.
 *  The admin layout already gates this subtree, but the page re-checks so the
 *  guard travels with the route rather than depending on its parent. */
export default async function CategoriesPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const categories = await listCategoriesWithCounts();

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Device categories</h1>
          <p className="subtle">The device classes items can be grouped and filtered by.</p>
        </div>
        <Link href="/admin" className="btn btn-secondary spacer">Back to admin</Link>
      </div>
      <CategoryManager categories={categories} />
    </div>
  );
}
