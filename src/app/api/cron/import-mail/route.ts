import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { hasValidBearerSecret } from "@/lib/cron-auth";
import { importItemsFromMail, GmailImportError } from "@/modules/items/gmail-import.service";

// Prisma and node crypto require the Node runtime. Never cached: this mutates
// the database on every call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same 60s ceiling, and for the same reason, as /api/cron/import-drive and
// POST /api/items/import — read the long comment on the latter before changing
// it. The Gmail reads are the pre-transaction work here, which is why they
// carry their own short timeout in gmail-import.service.ts.
export const maxDuration = 60;

/**
 * Scheduled collection of the MDM export from an emailed CSV attachment.
 *
 * Authenticated by the shared CRON_SECRET exactly as /api/cron/purge and
 * /api/cron/import-drive are — there is no user session on a scheduled hit —
 * and the import is attributed to the non-loginable
 * `mdm-import@service.invalid` service account.
 *
 * Note what this secret does and does not protect. It gates who may RUN a
 * sweep; it says nothing about whose email gets imported. That second question
 * is the allow-list plus DMARC check in gmail-import.service.ts, and it is the
 * boundary that matters — running a sweep is harmless, importing a stranger's
 * CSV is not.
 *
 * Idempotent by design: handled messages are labelled in Gmail and excluded
 * from the next sweep's query, so running this more often than exports arrive
 * costs one Gmail search.
 */
async function handle(req: NextRequest) {
  if (!hasValidBearerSecret(req, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const res = await importItemsFromMail();
    // Only when rows actually moved — an unchanged or absent export wrote
    // nothing, so busting the cache for it is pure churn on a quiet morning.
    if (res.status === "imported") {
      revalidatePath("/items");
      revalidatePath("/admin/audit");
    }
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    // A GmailImportError is the EXPECTED failure shape — a refused sender, a
    // missing attachment, a file that is not really a CSV — and its message is
    // written for the operator reading the task log. Returned rather than
    // flattened because the only caller holding CRON_SECRET is that operator,
    // and "which of these went wrong" is the whole diagnostic value. It names
    // addresses, byte counts and HTTP statuses, never row contents.
    if (e instanceof GmailImportError) {
      console.error("[cron/import-mail] import refused:", e.message);
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    console.error("[cron/import-mail] import failed:", e);
    return NextResponse.json({ error: "Mail import failed" }, { status: 500 });
  }
}

// Schedulers issue GET; POST is accepted for a manual authorized trigger.
export const GET = handle;
export const POST = handle;
