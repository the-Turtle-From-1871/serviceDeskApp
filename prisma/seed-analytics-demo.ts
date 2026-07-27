import "dotenv/config";

import prisma from "../src/lib/prisma";

/**
 * DEV-ONLY demo data for the readiness dashboard (`npm run db:seed:analytics`).
 *
 * The analytics widgets are driven by deviceCategory, deviceUIC,
 * deployableStatus and ItemStatusHistory. A fresh dev database has none of
 * those populated, so every chart renders empty and there is nothing to look
 * at while developing. This script assigns a plausible spread to the items
 * that already exist and back-dates a status timeline so the stacked-area
 * chart has a real shape.
 *
 * It is NOT wired into `db:seed` and must never be run against production —
 * it overwrites readiness fields on existing rows and fabricates history.
 *
 * GUARDING ON NODE_ENV IS NOT ENOUGH, and was the original bug here: this
 * runs under `tsx` with NODE_ENV unset, and its first act is to load whatever
 * DATABASE_URL sits in `.env` — which on a maintainer's machine can point at
 * the Supabase production database. The realistic accident is therefore
 * "prod URL, NODE_ENV undefined", which a NODE_ENV check waves straight
 * through. So the guard inspects the RESOLVED DATABASE_URL host instead and
 * refuses anything that is not an explicit local address.
 */

/** Hosts this fixture is allowed to touch. Anything else — Supabase, RDS, a
 *  tunnel, an IP — is refused. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal", "db", "postgres"]);

function assertSafeTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL could not be parsed; refusing to run.");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to run: DATABASE_URL points at "${host}", which is not a local database.\n` +
        "This fixture OVERWRITES deviceCategory / deviceUIC / deployableStatus / isAccountedFor on every\n" +
        "item, fabricates status history, and inserts fake CLOSED receipts. If you genuinely mean to run\n" +
        "it against this host, set ALLOW_NONLOCAL_DEMO_SEED=1 — and be certain it is not production.",
    );
  }
}

const CATEGORIES = ["Laptops", "Switches", "Printers", "Radios", "Tablets"];
const UICS = ["W6BTAA", "W6BTAB", "W6BTAC", "W91HRT"];
const STATUSES = ["DEPLOYED", "READY_TO_DEPLOY", "IN_REPAIR", "RETIRED"] as const;

async function main() {
  // NODE_ENV=production is refused unconditionally — the escape hatch below
  // must not be able to unlock it.
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-analytics-demo is a development fixture and must not run in production.");
  }
  // The host escape hatch is deliberately explicit and separate, so "I meant
  // to do this" is a conscious act rather than an unset variable.
  if (process.env.ALLOW_NONLOCAL_DEMO_SEED !== "1") assertSafeTarget();

  const items = await prisma.item.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
  if (items.length === 0) {
    console.log("No items found — nothing to decorate. Seed some items first.");
    return;
  }

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // Deterministic spread (index-based, not random) so repeated runs produce
  // the same fixture and screenshots stay comparable.
  //
  // BATCHED, not a per-item loop: CLAUDE.md forbids querying inside a loop, and
  // against the real 1,200+ catalogue the previous shape issued ~2,400 round
  // trips. Because the spread is a pure function of the index, items sharing a
  // (category, uic, status, accounted) combination can be updated together —
  // that is at most CATEGORIES x UICS x STATUSES x 2 buckets regardless of
  // fleet size — and all history rows go in ONE createMany.
  type Combo = { category: string; uic: string; status: string; accounted: boolean };
  const buckets = new Map<string, { combo: Combo; ids: string[] }>();
  const history: Array<{
    itemId: string;
    deployableStatus: (typeof STATUSES)[number];
    isAccountedFor: boolean;
    changedByName: string;
    source: string;
    createdAt: Date;
  }> = [];

  for (const [i, item] of items.entries()) {
    const combo: Combo = {
      category: CATEGORIES[i % CATEGORIES.length],
      uic: UICS[i % UICS.length],
      status: STATUSES[i % STATUSES.length],
      accounted: i % 7 !== 0, // ~14% unaccounted for, so the donut isn't a solid ring
    };
    const key = `${combo.category}|${combo.uic}|${combo.status}|${combo.accounted}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(item.id);
    else buckets.set(key, { combo, ids: [item.id] });

    // Back-date a small timeline: an earlier state, then the current one, so
    // the stacked area actually steps instead of being a flat band.
    const earlier = STATUSES[(i + 2) % STATUSES.length];
    history.push(
      {
        itemId: item.id,
        deployableStatus: earlier,
        isAccountedFor: true,
        changedByName: "System (demo fixture)",
        source: "system:demo",
        createdAt: new Date(now - (60 - (i % 45)) * day),
      },
      {
        itemId: item.id,
        deployableStatus: combo.status as (typeof STATUSES)[number],
        isAccountedFor: combo.accounted,
        changedByName: "System (demo fixture)",
        source: "system:demo",
        createdAt: new Date(now - (i % 25) * day),
      },
    );
  }

  for (const { combo, ids } of buckets.values()) {
    await prisma.item.updateMany({
      where: { id: { in: ids } },
      data: {
        deviceCategory: combo.category,
        deviceUIC: combo.uic,
        deployableStatus: combo.status as (typeof STATUSES)[number],
        isAccountedFor: combo.accounted,
      },
    });
  }
  await prisma.itemStatusHistory.createMany({ data: history });
  const historyRows = history.length;

  // Closed hand receipts, so the DA 2062 velocity chart has something to plot.
  // Spread across recent months; each carries a couple of items so the stack
  // has more than one category.
  const full = await prisma.item.findMany({
    select: { id: true, serialNumber: true, make: true, model: true },
    orderBy: { createdAt: "asc" },
  });
  const actor = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });

  // Which demo receipts already exist — ONE query up front, rather than a
  // findUnique per iteration inside the loop below.
  const plannedNumbers: string[] = [];
  for (let m = 0; m < 6; m++) for (let k = 0; k < 2; k++) plannedNumbers.push(`DEMO-${String(m).padStart(2, "0")}${k}`);
  const existingNumbers = new Set(
    (
      await prisma.transfer.findMany({
        where: { receiptNumber: { in: plannedNumbers } },
        select: { receiptNumber: true },
      })
    ).map((t) => t.receiptNumber),
  );

  let receipts = 0;
  for (let m = 0; m < 6; m++) {
    for (let k = 0; k < 2; k++) {
      const idx = (m * 2 + k) % Math.max(1, full.length - 2);
      const picked = full.slice(idx, idx + 2);
      if (picked.length === 0) continue;

      const closedAt = new Date(now - (m * 30 + 5) * day);
      const receiptNumber = `DEMO-${String(m).padStart(2, "0")}${k}`;
      // Idempotent: re-running the fixture must not collide on the unique
      // receiptNumber or pile up duplicate receipts. Checked against the set
      // fetched above rather than a query per iteration.
      if (existingNumbers.has(receiptNumber)) continue;

      await prisma.transfer.create({
        data: {
          receiptNumber,
          itemSummary: picked.map((p) => `${p.make} ${p.model}`).join(", "),
          senderName: "Demo Sender",
          receiverName: "Demo Receiver",
          receiverSignature: "",
          status: "CLOSED",
          createdAt: closedAt,
          closedAt,
          purgeAfter: new Date(closedAt.getTime() + 90 * day),
          createdByUserId: actor?.id ?? null,
          lines: {
            create: [
              {
                lineNo: 1,
                make: picked[0].make,
                model: picked[0].model,
                qtyAuth: picked.length,
                qtyIssued: picked.length,
                items: {
                  create: picked.map((p) => ({ itemId: p.id, serialNumber: p.serialNumber })),
                },
              },
            ],
          },
        },
      });
      receipts++;
    }
  }

  console.log(
    `Decorated ${items.length} items across ${UICS.length} UICs / ${CATEGORIES.length} categories, ` +
      `wrote ${historyRows} status-history rows, and created ${receipts} closed demo receipts.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
