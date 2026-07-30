import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin, AuthError } from "@/lib/authz";
import {
  listUnitsWithCounts,
  listUnassignedHomeUnits,
  lastImportAt,
} from "@/modules/items/units.service";
import { isImportStale } from "@/modules/items/import-freshness";
import { formatDateTimeHST } from "@/lib/datetime";
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

  // One Promise.all, not three sequential awaits — the page is a fixed
  // number of independent queries regardless of fleet size.
  const [units, unassigned, lastImport] = await Promise.all([
    listUnitsWithCounts(),
    listUnassignedHomeUnits(),
    lastImportAt(),
  ]);

  // Formatted and evaluated here, server-side, rather than passing the raw
  // Date into the "use client" UnitManager: a relative/staleness label
  // computed in a client component would be evaluated once at SSR time and
  // again at hydration, and those two clock reads can disagree right at an
  // hour boundary. Computing it once, here, and passing plain strings/
  // booleans down avoids that entirely (mirrors ServiceControls' dueAtLabel).
  //
  // The boundary math itself lives in the pure, independently-tested
  // isImportStale (src/modules/items/import-freshness.ts) — this page just
  // supplies the real request-time clock, the one thing that module can't
  // provide for itself and stay pure/testable.
  const lastImportLabel = lastImport ? formatDateTimeHST(lastImport) : null;
  const lastImportStale = isImportStale(lastImport, new Date());

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
      <UnitManager
        units={units}
        unassigned={unassigned}
        lastImportLabel={lastImportLabel}
        lastImportStale={lastImportStale}
      />
    </div>
  );
}
