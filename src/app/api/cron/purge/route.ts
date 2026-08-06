import { NextResponse, type NextRequest } from "next/server";
import { purgeExpiredTransfers } from "@/modules/transfers/purge.service";
import { purgeDeactivatedUsers } from "@/modules/users/account-purge.service";
import { purgeStaleDrafts } from "@/modules/receipts/drafts.service";
import { sendOverdueTransferAlerts } from "@/modules/transfers/timer-alert.service";
import { sendOverdueServiceAlerts } from "@/modules/service-queue/timer-alert.service";
import { hasValidBearerSecret } from "@/lib/cron-auth";

// Prisma + node crypto require the Node.js runtime (not edge). Never cache: this
// mutates the database and must run fresh on every scheduled invocation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nightly maintenance worker: permanently purge expired closed receipts (90 days
// after close), hard-delete accounts inactive for 3+ months, and purge idle receipt
// drafts (30 days untouched). All sweeps run independently; a failure in one is
// reported without blocking the other.
async function handle(req: NextRequest) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. This shared secret is
  // the authentication for the endpoint — there is no user session on a cron hit —
  // so we reject anything without an exact, constant-time match before touching data.
  if (!hasValidBearerSecret(req, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  try {
    const [transfers, users, drafts, transferAlerts, serviceAlerts] = await Promise.all([
      purgeExpiredTransfers(now),
      purgeDeactivatedUsers(now),
      purgeStaleDrafts(now),
      sendOverdueTransferAlerts(now),
      sendOverdueServiceAlerts(now),
    ]);
    return NextResponse.json({
      ok: true,
      transfers: { deletedCount: transfers.deletedCount },
      users: { deletedCount: users.deletedCount, skippedCount: users.skipped.length },
      drafts: { deletedCount: drafts.deletedCount },
      alerts: { overdueTransfers: transferAlerts.alertedCount, overdueService: serviceAlerts.alertedCount },
    });
  } catch (e) {
    console.error("[cron/purge] purge sweep failed:", e);
    return NextResponse.json({ error: "Purge failed" }, { status: 500 });
  }
}

// Vercel Cron issues GET requests; POST is accepted for manual/authorized triggers.
export const GET = handle;
export const POST = handle;
