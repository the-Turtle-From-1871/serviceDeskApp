import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import { listUnitsWithCounts } from "@/modules/items/units.service";
import { UnitManager } from "./UnitManager";

export const metadata = { title: "Units" };

/** ADMIN-only: the unit vocabulary is what the importer resolves device names
 *  against, so curating it is a privileged capability. The admin layout already
 *  gates this subtree, but the page re-checks so the guard travels with the
 *  route rather than depending on its parent. */
export default async function UnitsPage() {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof AuthError) redirect(e.code === "FORBIDDEN" ? "/" : "/login");
    throw e;
  }

  const units = await listUnitsWithCounts();

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1 className="page-title">Units</h1>
          <p className="subtle">
            Abbreviations the importer resolves device names against. Correcting a
            unit&apos;s name also updates every item currently assigned to it.
          </p>
        </div>
        <Link href="/admin" className="btn btn-secondary spacer">Back to admin</Link>
      </div>
      <UnitManager units={units} />
    </div>
  );
}
