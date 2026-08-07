import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { hasValidBearerSecret } from "@/lib/cron-auth";
import { commitImport } from "@/modules/items/items.service";
import { getImportActor } from "@/modules/items/import-actor";

// Prisma and node crypto require the Node runtime. Never cached: this mutates
// the database on every call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MUST be declared, and the invariant is bigger than just "exceed the
// transaction budget":
//
//   maxDuration > pre-transaction work + maxWait + timeout
//
// `maxWait` (5s, time spent waiting to acquire a pool connection before the
// transaction even starts) and `timeout` (40s, items.service.ts) bound
// commitImport's interactive transaction, consumed SEQUENTIALLY — 45s. But
// real work happens BEFORE that transaction opens, in this same invocation,
// and it is not free: `req.formData()` buffering the whole upload (above),
// `getImportActor()` (one DB round trip), `file.text()`, and inside
// commitImport, `Promise.all([loadExistingBySerial, loadUnitMap])` — two
// parallel queries, the first of which can return up to MAX_IMPORT_ROWS
// (2000) rows × 15 columns. On a cold start, add Prisma engine
// initialization and the first pool connect on top of that. If the platform
// kills the function before this pre-transaction work finishes, it never
// reaches the transaction at all — same bad outcome (no clean 500 into the
// catch below), just earlier.
//
// 60 is used deliberately, NOT a larger number picked "to be safe": Vercel
// REJECTS an unsupported maxDuration at DEPLOY time, on every plan below
// whatever ceiling that plan allows, and `next build` in CI cannot catch
// that — the first place an unverified higher value would fail is the
// production deployment itself. 60 is accepted on every Vercel plan (it's
// also what the interactive /admin/items/import page already uses). That
// leaves ~15s for everything outside the 45s transaction — pre-transaction
// work plus unwind — which is the margin `timeout` was lowered from 50s to
// 40s to buy back (see the comment at commitImport's transaction options).
// Raise maxDuration later only once a measured production run actually
// needs more AND the target plan's real ceiling has been confirmed.
export const maxDuration = 60;

/** Generous ceiling on the uploaded body. MAX_IMPORT_ROWS (2000) of this CSV's
 *  widest realistic shape is well under this; anything near it is a mistake. */
const MAX_CSV_BYTES = 5_000_000;

export async function POST(req: NextRequest) {
  // Checked BEFORE the body is read, so an unauthenticated flood costs one
  // constant-time compare rather than a multi-megabyte read.
  if (!hasValidBearerSecret(req, process.env.MDM_IMPORT_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Cheap pre-check against the DECLARED Content-Length, before formData()
  // buffers the whole body — this is the check that actually avoids reading
  // an oversized upload into memory. It is not the only guard: Content-Length
  // is caller-supplied and can be absent (chunked transfer) or simply wrong,
  // so `Number.isFinite` guards a missing/non-numeric header by skipping this
  // check rather than rejecting or throwing, and the post-parse check below
  // (on the buffered file's real size) is the backstop for that case.
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CSV_BYTES) {
    return NextResponse.json({ error: "That file is too large to import." }, { status: 413 });
  }

  let file: File;
  try {
    const form = await req.formData();
    const candidate = form.get("file");
    if (!(candidate instanceof File) || candidate.size === 0) {
      return NextResponse.json({ error: "Attach the CSV as the `file` field." }, { status: 400 });
    }
    if (!candidate.name.toLowerCase().endsWith(".csv")) {
      return NextResponse.json({ error: "The file must be a .csv file." }, { status: 400 });
    }
    if (candidate.size > MAX_CSV_BYTES) {
      // Backstop for a missing or understated Content-Length: by this point
      // formData() has already buffered the body, so this protects against
      // ACTING on an oversized file, not against the memory cost of
      // receiving it — the pre-check above is what does that.
      return NextResponse.json({ error: "That file is too large to import." }, { status: 413 });
    }
    file = candidate;
  } catch {
    return NextResponse.json({ error: "Expected a multipart/form-data body." }, { status: 400 });
  }

  try {
    const actor = await getImportActor();
    const text = await file.text();

    // Empty resolutions is CORRECT, not a shortcut. An unrecognised unit
    // abbreviation does not block a row: the item imports with a blank
    // homeUnit and comes back in `unresolved` for an admin to teach later at
    // /admin/units. See readinessState / planImport for why this is safe.
    const res = await commitImport(text, file.name, [], actor);
    if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });

    revalidatePath("/items");
    revalidatePath("/admin/audit");

    // Field set matches DEPLOY.md's "automated MDM import" contract exactly —
    // do not add or rename fields here without updating that doc in the same
    // commit.
    return NextResponse.json({
      added: res.added,
      updated: res.updated,
      unchanged: res.unchanged,
      detected: res.detected,
      skipped: res.skipped,
      unresolved: res.unresolved,
      mismatches: res.mismatches,
    });
  } catch (e) {
    console.error("[api/items/import] import failed:", e);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
