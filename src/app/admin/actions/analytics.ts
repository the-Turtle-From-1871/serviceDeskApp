"use server";
import { z } from "zod";
import { requireCapability, AuthError } from "@/lib/authz";
import { listStaleDevices } from "@/app/admin/analytics/analytics.service";
import { STALE_DEVICE_COLUMNS, type StaleDeviceRow } from "@/app/admin/analytics/analytics.types";

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
  | { ok: true; columns: string[]; rows: StaleDeviceRow[]; truncated: boolean };

/**
 * The 30-90 day stale-device chase list, as spreadsheet rows.
 *
 * The rows are built server-side and the file is written in the browser: that
 * keeps ONE CSV writer in the app — the client one, whose formula-injection
 * guard matters more on this sheet than on any other, because Device name,
 * Holder and Last logon user all arrive verbatim from the MDM CSV import.
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
    return { ok: true, columns: [...STALE_DEVICE_COLUMNS], rows, truncated };
  } catch (e) {
    // Generic to the client, detail to the server log (CLAUDE.md §5).
    console.error("[exportStaleDevicesAction] unexpected error:", e);
    return { error: "Something went wrong building that export. Please try again." };
  }
}
