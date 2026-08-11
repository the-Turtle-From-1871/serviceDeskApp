import { beforeEach, expect, test } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../tests/helpers/db";
import { getImportActor, IMPORT_SERVICE_ACCOUNT_EMAIL } from "./import-actor";

// resetDb() TRUNCATEs User (and Item, Unit) CASCADE before every test, so the
// migration-seeded service account is wiped from the test DB right along with
// everything else — it does NOT survive between tests, migration or no
// migration. Each test that needs it present seeds it itself, with the same
// shape the migration writes (see
// prisma/migrations/20260730000000_import_service_account/migration.sql).
function seedServiceAccount() {
  return prisma.user.create({
    data: {
      id: "svcmdmimport000000000000",
      name: "MDM Import (automated)",
      email: IMPORT_SERVICE_ACCOUNT_EMAIL,
      passwordHash: "!no-login-service-account",
      role: "USER",
      isActive: false,
      deactivatedAt: null,
    },
  });
}

beforeEach(() => resetDb());

test("getImportActor resolves the seeded service account", async () => {
  const seeded = await seedServiceAccount();

  const actor = await getImportActor();

  expect(actor.id).toBe(seeded.id);
  expect(actor.name).toBe("MDM Import (automated)");
});

// The more valuable test: prove the fail-loudly behaviour. If the service
// account is ever missing (migration not applied, row deleted by hand),
// getImportActor must throw rather than silently attribute an automated
// import to some other account — and the message must name the address so
// the failure is diagnosable from a log line alone.
test("getImportActor throws when the service account is missing", async () => {
  await expect(getImportActor()).rejects.toThrow(IMPORT_SERVICE_ACCOUNT_EMAIL);
});

test("the service account cannot be signed in as", async () => {
  await seedServiceAccount();

  const user = await prisma.user.findUnique({
    where: { email: IMPORT_SERVICE_ACCOUNT_EMAIL },
    select: { isActive: true, deactivatedAt: true, role: true },
  });

  // isActive:false is what blocks authentication (see defaultGetSession in
  // src/lib/authz.ts, which returns null for an inactive user regardless of
  // the password hash).
  expect(user?.isActive).toBe(false);
  // deactivatedAt stays null so the account-purge worker (which only
  // considers rows with a non-null deactivatedAt) never considers it.
  expect(user?.deactivatedAt).toBeNull();
  expect(user?.role).toBe("USER");
});
