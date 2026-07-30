import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { hasValidBearerSecret } from "@/lib/cron-auth";
import { commitImport } from "@/modules/items/items.service";
import { getImportActor } from "@/modules/items/import-actor";

// Prisma and node crypto require the Node runtime. Never cached: this mutates
// the database on every call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// MUST be declared, and MUST exceed commitImport's transaction budget.
//
// commitImport runs an interactive transaction configured with
// `timeout: 50_000, maxWait: 5_000` (items.service.ts). Those are consumed
// SEQUENTIALLY, so the function must be allowed to live longer than their sum
// (55s) or the platform kills it mid-transaction instead of letting it abort
// cleanly into the catch below — which is exactly the confusing generic failure
// the batching work went in to remove. The interactive import page sets 60;
// this one is a nightly job with nobody waiting, so it is given generous
// headroom above the 55s floor. (300 is commonly cited as the Vercel Hobby
// plan's serverless function ceiling, but that has NOT been verified against
// this project's actual Vercel configuration — the number that matters and
// IS verified here is that it must exceed 55s. Confirm the plan's real
// ceiling before relying on 300 specifically, and lower this if it turns out
// to exceed what the deployed plan allows.)
export const maxDuration = 300;

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
