import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { purgeExpiredTransfers } from "@/modules/transfers/purge.service";
import { purgeDeactivatedUsers } from "@/modules/users/account-purge.service";
import { sendOverdueTransferAlerts } from "@/modules/transfers/timer-alert.service";
import { sendOverdueServiceAlerts } from "@/modules/service-queue/timer-alert.service";

// Prisma + node crypto require the Node.js runtime (not edge). Never cache: this
// mutates the database and must run fresh on every scheduled invocation.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. This shared secret is
// the authentication for the endpoint — there is no user session on a cron hit —
// so we reject anything without an exact, constant-time match before touching data.
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if the secret was never configured
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Nightly maintenance worker: permanently purge expired closed receipts (90 days
// after close) and hard-delete accounts inactive for 3+ months. Both sweeps run
// independently; a failure in one is reported without blocking the other.
async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  try {
    const [transfers, users, transferAlerts, serviceAlerts] = await Promise.all([
      purgeExpiredTransfers(now),
      purgeDeactivatedUsers(now),
      sendOverdueTransferAlerts(now),
      sendOverdueServiceAlerts(now),
    ]);
    return NextResponse.json({
      ok: true,
      transfers: { deletedCount: transfers.deletedCount },
      users: { deletedCount: users.deletedCount, skippedCount: users.skipped.length },
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
