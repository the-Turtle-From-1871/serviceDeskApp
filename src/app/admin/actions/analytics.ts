"use server";
import { z } from "zod";
import { requireCapability, AuthError } from "@/lib/authz";
import { listStaleDevices } from "@/app/admin/analytics/analytics.service";
import { buildStaleDevicesWorkbook } from "@/app/admin/analytics/stale-workbook";

/* ============================================================
   Export actions for the readiness dashboard.

   READ-ONLY. Nothing here writes, so there is no revalidation and no audit
   row — this hands back rows the dashboard could already display, in a shape a
   spreadsheet can open.

   Gated on VIEW_ANALYTICS, the same capability as the page itself. That is not
   belt-and-braces: a Server Action is a POST endpoint in its own right, so the
   page's gate does not cover it, and requireCapability re-reads role, isActive
   AND the capability grants from the DB per request — a revoked grant takes
   effect on the next click, not the next sign-in.
   ============================================================ */

/**
 * The dashboard's unit scope, as it arrives from the client.
 *
 * Re-validated here rather than trusted, on the ordinary principle that a
 * Server Action's arguments are attacker-controlled. The values are bound as
 * query parameters downstream so they were never an injection route; what this
 * bounds is size and type — an unbounded string reaching a `WHERE` clause is a
 * cheap way to make the database work hard, and a non-string would reach
 * Postgres as a type error rather than a filter.
 *
 * A blank normalises to null ("unfiltered"), matching what the page does with
 * an empty querystring param, so `?uic=` and no `uic` at all mean one thing.
 */
const scopeSchema = z.object({
  uic: z.string().trim().max(64).nullish().transform((v) => v || null),
  unit: z.string().trim().max(200).nullish().transform((v) => v || null),
});

/* Annotated, not inferred: a `"use server"` module may only export async
   functions, so the shape stays local — but naming it keeps the result a real
   discriminated union the client can narrow with `"error" in res`. */
type StaleExportResult =
  | { error: string }
  | { ok: true; base64: string; rowCount: number; truncated: boolean };

/**
 * The 30-90 day stale-device chase list, as a colour-coded .xlsx.
 *
 * THE WHOLE FILE IS BUILT HERE and handed back as base64 — unlike every other
 * export on this dashboard, which returns rows for the browser's shared CSV
 * writer. The rows carry a colour per device (red not compliant, orange 60-90
 * days, yellow 30-59), and CSV cannot express one; see `stale-workbook.ts` for
 * why the writer lives on the server and why formula injection stops being a
 * concern once the format is xlsx rather than CSV.
 *
 * Base64 rather than a download route so this stays a Server Action: the
 * capability re-check below, the "you no longer have access" sentence and the
 * truncation notice all survive, where a route would answer a revoked grant
 * with a bare 403 in a new tab. The payload is bounded by STALE_EXPORT_MAX.
 */
export async function exportStaleDevicesAction(input: unknown): Promise<StaleExportResult> {
  try {
    await requireCapability("VIEW_ANALYTICS");
  } catch (e) {
    // A demoted or signed-out admin gets a sentence, not an error boundary: a
    // 500 from a download button reads as "the export is broken".
    if (e instanceof AuthError) {
      return {
        error:
          e.code === "FORBIDDEN"
            ? "You no longer have access to analytics."
            : "Your session has expired. Sign in and try again.",
      };
    }
    throw e;
  }

  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) return { error: "That filter could not be read. Reload the page." };

  try {
    const { rows, truncated } = await listStaleDevices(parsed.data);
    // An empty window is not an error, and the caller says so in a sentence
    // rather than handing over a workbook of headers and a legend.
    if (rows.length === 0) return { ok: true, base64: "", rowCount: 0, truncated: false };
    const workbook = await buildStaleDevicesWorkbook(rows, parsed.data, truncated);
    return { ok: true, base64: workbook.toString("base64"), rowCount: rows.length, truncated };
  } catch (e) {
    // Generic to the client, detail to the server log (CLAUDE.md §5).
    console.error("[exportStaleDevicesAction] unexpected error:", e);
    return { error: "Something went wrong building that export. Please try again." };
  }
}
