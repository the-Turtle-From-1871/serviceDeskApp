import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { readinessState, type ReadinessSignals, type ReadinessState } from "./readiness";
import { READINESS_CASE, READINESS_JOINS } from "./readiness.sql";

/**
 * Readiness is expressed TWICE — once in TypeScript for a single row, once in
 * SQL for the dashboard's fleet-wide aggregates. Two copies of a rule drift.
 *
 * This test is the thing that stops them: it builds real rows covering every
 * branch and both sides of every precedence boundary, then asserts the SQL
 * CASE and readinessState() return the SAME state for each. Change one without
 * the other and this fails.
 */

const JAN = new Date("2026-01-01T00:00:00Z");
const JUN = new Date("2026-06-01T00:00:00Z");

type Fixture = {
  name: string;
  expected: ReadinessState;
  retired?: boolean;
  flagged?: boolean;
  onOpenReceipt?: boolean;
  lastLogonAt?: Date | null;
  lastLogonUser?: string | null;
  markedReadyAt?: Date | null;
};

const FIXTURES: Fixture[] = [
  { name: "no signals", expected: "UNTRIAGED" },
  { name: "retired beats all", expected: "RETIRED", retired: true, flagged: true, onOpenReceipt: true, lastLogonUser: "a@b.mil", markedReadyAt: JAN },
  { name: "service flag beats open receipt", expected: "IN_REPAIR", flagged: true, onOpenReceipt: true },
  { name: "service flag beats mdm user", expected: "IN_REPAIR", flagged: true, lastLogonUser: "a@b.mil" },
  { name: "open receipt", expected: "DEPLOYED", onOpenReceipt: true },
  { name: "open receipt beats fresh marking", expected: "DEPLOYED", onOpenReceipt: true, markedReadyAt: JUN },
  { name: "marked ready", expected: "READY_TO_DEPLOY", markedReadyAt: JAN },
  { name: "marking beats stale logon", expected: "READY_TO_DEPLOY", markedReadyAt: JUN, lastLogonAt: JAN, lastLogonUser: "a@b.mil" },
  { name: "logon after marking flips to deployed", expected: "DEPLOYED", markedReadyAt: JAN, lastLogonAt: JUN, lastLogonUser: "a@b.mil" },
  { name: "unparseable logon keeps marking", expected: "READY_TO_DEPLOY", markedReadyAt: JAN, lastLogonAt: null, lastLogonUser: "a@b.mil" },
  { name: "legacy mdm user only", expected: "DEPLOYED", lastLogonUser: "a@b.mil" },
  { name: "blank mdm user is no signal", expected: "UNTRIAGED", lastLogonUser: "   " },
  { name: "logon date with no user", expected: "UNTRIAGED", lastLogonAt: JUN },
];

const PREFIX = "PARITY-";
let adminId: string;

beforeAll(async () => {
  // Seed our OWN admin rather than borrowing whichever one happens to be in the
  // shared test DB. `Item.createdById` is a required FK, so this test needs a
  // user row — but it deliberately does NOT reset the database (its fixtures are
  // PREFIX-scoped so it can run against a populated one). Reading an ambient
  // admin made it pass or fail on FILE ORDER: any DB-backed test that ran
  // earlier and called resetDb() truncated the user it was counting on, and the
  // failure surfaced here rather than where the truncation happened. Upsert, so
  // repeat runs and a leftover row from a previous run are both fine.
  const admin = await prisma.user.upsert({
    where: { email: "parity-fixture@example.invalid" },
    update: {},
    create: { name: "Parity Fixture", email: "parity-fixture@example.invalid", passwordHash: "x", role: "ADMIN" },
    select: { id: true },
  });
  adminId = admin.id;

  for (const [i, f] of FIXTURES.entries()) {
    const serial = `${PREFIX}${i}`;
    const item = await prisma.item.create({
      data: {
        make: "P", model: "Q", serialNumber: serial, deviceName: `parity-${i}`,
        createdById: adminId,
        status: f.retired ? "RETIRED" : "ACTIVE",
        lastLogonAt: f.lastLogonAt ?? null,
        lastLogonUserPrincipalName: f.lastLogonUser ?? null,
        markedReadyAt: f.markedReadyAt ?? null,
      },
    });
    if (f.flagged) {
      await prisma.serviceQueueItem.create({
        data: { itemId: item.id, serviceType: "REPAIR", status: "PENDING" },
      });
    }
    if (f.onOpenReceipt) {
      await prisma.transfer.create({
        data: {
          receiptNumber: `${PREFIX}R${i}`, itemSummary: "x",
          senderName: "s", receiverName: "r", receiverSignature: "", status: "OPEN",
          lines: {
            create: [{
              lineNo: 1, make: "P", model: "Q", qtyAuth: 1, qtyIssued: 1,
              items: { create: [{ itemId: item.id, serialNumber: serial }] },
            }],
          },
        },
      });
    }
  }
});

afterAll(async () => {
  await prisma.transfer.deleteMany({ where: { receiptNumber: { startsWith: PREFIX } } });
  await prisma.item.deleteMany({ where: { serialNumber: { startsWith: PREFIX } } });
});

describe("readiness SQL/TS parity", () => {
  it("agrees on every branch and precedence boundary", async () => {
    const rows = await prisma.$queryRaw<{ serialNumber: string; state: string }[]>(Prisma.sql`
      SELECT i."serialNumber" AS "serialNumber", ${READINESS_CASE} AS state
      FROM "Item" i
      ${READINESS_JOINS}
      WHERE i."serialNumber" LIKE ${PREFIX + "%"}
    `);
    const bySerial = new Map(rows.map((r) => [r.serialNumber.toUpperCase(), r.state]));
    expect(rows).toHaveLength(FIXTURES.length);

    const disagreements: string[] = [];
    for (const [i, f] of FIXTURES.entries()) {
      const signals: ReadinessSignals = {
        status: f.retired ? "RETIRED" : "ACTIVE",
        flaggedForService: !!f.flagged,
        onOpenReceipt: !!f.onOpenReceipt,
        lastLogonAt: f.lastLogonAt ?? null,
        lastLogonUser: f.lastLogonUser ?? null,
        markedReadyAt: f.markedReadyAt ?? null,
      };
      const ts = readinessState(signals);
      const sql = bySerial.get(`${PREFIX}${i}`);
      if (ts !== f.expected) disagreements.push(`${f.name}: TS gave ${ts}, expected ${f.expected}`);
      if (sql !== f.expected) disagreements.push(`${f.name}: SQL gave ${sql}, expected ${f.expected}`);
    }
    expect(disagreements).toEqual([]);
  });
});
