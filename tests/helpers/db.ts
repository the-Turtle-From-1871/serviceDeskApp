import prisma from "@/lib/prisma";

export async function resetDb() {
  // Safety belt: this TRUNCATE must only ever run against the test database.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("handreceipt_test")) {
    throw new Error(
      `resetDb() refused to run: DATABASE_URL does not target handreceipt_test (got: ${url})`
    );
  }

  // All three tables exist as of P2 Task 1 (Item + Transfer created together).
  // Contact is listed explicitly rather than relying on its FK to User to pull
  // it in via CASCADE — a contact with a null createdById must be cleared too.
  // SignatureAsset likewise: ItemAudit/ReturnTransaction reference it ON DELETE
  // RESTRICT, so nothing cascades INTO it and assets would otherwise accumulate
  // across runs — which quietly breaks any test that counts stored signatures.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Contact","Transfer","Item","User","Unit","SignatureAsset" RESTART IDENTITY CASCADE;`
  );
}
