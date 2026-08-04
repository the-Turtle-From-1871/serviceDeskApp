import "dotenv/config";

import prisma from "../src/lib/prisma";

/**
 * DEV-ONLY demo data for the readiness dashboard (`npm run db:seed:analytics`).
 *
 * The analytics widgets are driven by deviceCategory, deviceUIC, lastAuditedAt
 * and the DERIVED readiness state. A fresh dev database has none of those
 * populated, so every chart renders empty and there is nothing to look at while
 * developing. This script assigns a plausible spread to the items that already
 * exist.
 *
 * READINESS IS DERIVED, NOT SET (see modules/items/readiness.ts): there is no
 * status column to write and no history table to fabricate. So the fixture
 * writes the SIGNALS readiness reads — a service flag, a markedReadyAt stamp,
 * an MDM last-logon user + instant — and lets the real derivation produce the
 * spread. That means the demo data exercises the same code path production
 * does, instead of a shortcut that could disagree with it.
 *
 * It is NOT wired into `db:seed` and must never be run against production —
 * it overwrites readiness signals and audit dates on existing rows.
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
        "This fixture OVERWRITES deviceCategory / deviceUIC / lastAuditedAt and the readiness signals\n" +
        "(markedReadyAt, MDM last-logon) on every item, flags items for service, and inserts fake CLOSED\n" +
        "receipts. If you genuinely mean to run it against this host, set ALLOW_NONLOCAL_DEMO_SEED=1 —\n" +
        "and be certain it is not production.",
    );
  }
}

const CATEGORIES = ["Laptops", "Switches", "Printers", "Radios", "Tablets"];
const UICS = ["W6BTAA", "W6BTAB", "W6BTAC", "W91HRT"];

/** The readiness OUTCOMES this fixture aims for. Nothing writes these strings
 *  to the database — each one names a combination of signals (below) that the
 *  real derivation should turn into that state. */
const READINESS_SPREAD = ["deployed", "ready", "repair", "untriaged"] as const;
type DemoReadiness = (typeof READINESS_SPREAD)[number];

/** `Item.lastLogonDate` is the MDM export's verbatim text; `lastLogonAt` is the
 *  instant parsed from it on import. The fixture writes both, in the same shape
 *  parseLastLogonAt expects, so the demo rows look like imported ones. */
const mdmDate = (d: Date) =>
  `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} 8:00:00 AM`;

const DEMO_LOGON_USER = "demo.user@example.mil";

/** The signal set that should derive to `readiness`. See readiness.ts for the
 *  precedence these lean on. */
function signalsFor(readiness: DemoReadiness, now: number, day: number) {
  switch (readiness) {
    case "deployed": {
      // In a soldier's hands with no hand receipt on file — the ~1,053 devices
      // that predate the app. Rule 5 (has an MDM last-logon user) is what fires.
      // `markedReadyAt` MUST stay null: rule 4 outranks rule 5, so a stamp here
      // would derive to READY_TO_DEPLOY and this bucket would seed empty. (It
      // used to carry one, back when a newer logon could expire the stamp.)
      const logon = new Date(now - 3 * day);
      return {
        markedReadyAt: null,
        lastLogonUserPrincipalName: DEMO_LOGON_USER,
        lastLogonDate: mdmDate(logon),
        lastLogonAt: logon,
      };
    }
    case "ready":
      // Marked back on the shelf with nothing since to contradict it.
      return {
        markedReadyAt: new Date(now - 5 * day),
        lastLogonUserPrincipalName: null,
        lastLogonDate: null,
        lastLogonAt: null,
      };
    case "repair": {
      // Deliberately carries a logon as well: the PENDING service row written
      // below must OUTRANK it. If this bucket ever renders as Deployed, the
      // precedence has been broken.
      const logon = new Date(now - 60 * day);
      return {
        markedReadyAt: null,
        lastLogonUserPrincipalName: DEMO_LOGON_USER,
        lastLogonDate: mdmDate(logon),
        lastLogonAt: logon,
      };
    }
    case "untriaged":
      // No signal at all — "we have never heard anything about this device".
      return {
        markedReadyAt: null,
        lastLogonUserPrincipalName: null,
        lastLogonDate: null,
        lastLogonAt: null,
      };
  }
}

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
  // (category, uic, readiness, audited) combination can be updated together —
  // that is at most CATEGORIES x UICS x READINESS_SPREAD x 3 buckets regardless
  // of fleet size — and the service flags go in ONE createMany.
  //
  // `audited` drives the audit-readiness donut, which reads lastAuditedAt rather
  // than any stored accountability flag: null = never audited, a recent date =
  // compliant, an old one = overdue. Spread across all three so the donut shows
  // three wedges instead of one ring.
  //
  // NOTE this writes lastAuditedAt WITHOUT matching ItemAudit rows, so a demo
  // item shows an audit light with an empty audit history on its detail page.
  // Acceptable for a local fixture; do not copy the shortcut into app code,
  // where recordAudit maintains both in one transaction.
  type Combo = { category: string; uic: string; readiness: DemoReadiness; audited: "recent" | "old" | "never" };
  const buckets = new Map<string, { combo: Combo; ids: string[] }>();
  const needService: string[] = [];

  for (const [i, item] of items.entries()) {
    const combo: Combo = {
      category: CATEGORIES[i % CATEGORIES.length],
      uic: UICS[i % UICS.length],
      readiness: READINESS_SPREAD[i % READINESS_SPREAD.length],
      audited: i % 7 === 0 ? "never" : i % 3 === 0 ? "old" : "recent",
    };
    const key = `${combo.category}|${combo.uic}|${combo.readiness}|${combo.audited}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.ids.push(item.id);
    else buckets.set(key, { combo, ids: [item.id] });

    if (combo.readiness === "repair") needService.push(item.id);
  }

  for (const { combo, ids } of buckets.values()) {
    await prisma.item.updateMany({
      where: { id: { in: ids } },
      data: {
        deviceCategory: combo.category,
        deviceUIC: combo.uic,
        ...signalsFor(combo.readiness, now, day),
        lastAuditedAt:
          combo.audited === "never"
            ? null
            : combo.audited === "old"
              ? new Date(now - 500 * day) // > 1 year ago = overdue
              : new Date(now - 30 * day), // within the period = compliant
      },
    });
  }

  // The IN_REPAIR half of the spread. ServiceQueueItem is unique per item, so
  // skipDuplicates makes a re-run idempotent instead of a unique violation —
  // and the rows are left alone rather than reset, so a queue item completed
  // by hand while demoing stays completed.
  const flagged = await prisma.serviceQueueItem.createMany({
    data: needService.map((itemId) => ({
      itemId,
      serviceType: "REPAIR" as const,
      status: "PENDING" as const,
      dueAt: new Date(now + 7 * day),
    })),
    skipDuplicates: true,
  });

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
      `flagged ${flagged.count} for service, and created ${receipts} closed demo receipts.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
