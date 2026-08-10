import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { hasValidBearerSecret } from "@/lib/cron-auth";
import { importItemsFromDrive, DriveImportError } from "@/modules/items/drive-import.service";

// Prisma and node crypto require the Node runtime. Never cached: this mutates
// the database on every call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same 60s ceiling, and for the same reason, as POST /api/items/import — read
// the long comment there before changing it. This route adds one more piece of
// pre-transaction work (the Drive fetch), which is why that fetch carries its
// own short timeout in drive-import.service.ts.
export const maxDuration = 60;

/**
 * Scheduled collection of the MDM export from the configured public Drive link.
 *
 * Authenticated by the shared CRON_SECRET exactly as /api/cron/purge is — there
 * is no user session on a scheduled hit — and the import is attributed to the
 * non-loginable `mdm-import@service.invalid` service account.
 *
 * Idempotent by design: an unchanged export is fingerprinted, recognised and
 * skipped without opening a transaction, so running this more often than the
 * export is regenerated costs one HTTP fetch and one indexed read.
 */
async function handle(req: NextRequest) {
  if (!hasValidBearerSecret(req, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await importItemsFromDrive();
    // Only when rows actually moved. An unchanged export wrote nothing, so
    // busting the cache for it would be pure churn on every quiet morning.
    if (res.status === "imported") {
      revalidatePath("/items");
      revalidatePath("/admin/audit");
    }
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    // A DriveImportError is the EXPECTED failure shape — a revoked share, a
    // dead link, an oversized or malformed file — and its message is written
    // for the operator reading the cron log. It is returned rather than
    // flattened into a generic message because the only caller holding
    // CRON_SECRET is that operator, and "which of these went wrong" is the
    // whole diagnostic value. It names URLs, HTTP statuses and byte counts,
    // never row contents, so no property-book PII travels in it.
    if (e instanceof DriveImportError) {
      console.error("[cron/import-drive] import refused:", e.message);
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error("[cron/import-drive] import failed:", e);
    return NextResponse.json({ error: "Drive import failed" }, { status: 500 });
  }
}

// Schedulers issue GET; POST is accepted for a manual authorized trigger.
export const GET = handle;
export const POST = handle;
