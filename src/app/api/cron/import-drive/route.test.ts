import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import prisma from "@/lib/prisma";
import { resetDb } from "../../../../../tests/helpers/db";
import { IMPORT_SERVICE_ACCOUNT_EMAIL } from "@/modules/items/import-actor";

// Same stub, same reason, as src/app/api/items/import/route.test.ts:
// `revalidatePath` needs a request-scoped store that only exists inside a real
// Next render, and this test calls the handler directly.
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { GET } from "./route";

const SECRET = "test-cron-secret";
const URL_OK = "https://drive.example.test/uc?export=download&id=FILEID";

const get = (auth?: string) =>
  GET(
    new Request("https://example.test/api/cron/import-drive", {
      headers: auth ? { authorization: auth } : undefined,
    }) as never,
  );

/** Stand in for Drive. Real `fetch` is never called by these tests. */
function mockDrive(body: string, init: { status?: number; contentType?: string | null } = {}) {
  const headers = new Headers();
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "text/csv");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: init.status ?? 200, headers })),
  );
}

// resetDb() TRUNCATEs User, so the migration-seeded service account goes with
// it — seed it per test exactly as the sibling route test does, with the shape
// prisma/migrations/20260730000000_import_service_account writes.
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

// Captured and restored: `fileParallelism: false` shares one worker across every
// test file, so a leaked CRON_SECRET / DRIVE_CSV_URL would reach later files.
const priorSecret = process.env.CRON_SECRET;
const priorUrl = process.env.DRIVE_CSV_URL;

beforeEach(async () => {
  await resetDb();
  await seedServiceAccount();
  process.env.CRON_SECRET = SECRET;
  process.env.DRIVE_CSV_URL = URL_OK;
  revalidatePath.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (priorSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = priorSecret;
  if (priorUrl === undefined) delete process.env.DRIVE_CSV_URL;
  else process.env.DRIVE_CSV_URL = priorUrl;
});

describe("GET /api/cron/import-drive", () => {
  it("rejects a request with no Authorization header and imports nothing", async () => {
    mockDrive("serialNumber,make,model\nDRIVE-1,Dell,7440\n");
    const res = await get();
    expect(res.status).toBe(401);
    expect(await prisma.item.count()).toBe(0);
  });

  it("rejects a wrong secret", async () => {
    mockDrive("serialNumber,make,model\nDRIVE-1,Dell,7440\n");
    const res = await get("Bearer wrong");
    expect(res.status).toBe(401);
    expect(await prisma.item.count()).toBe(0);
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    mockDrive("serialNumber,make,model\nDRIVE-1,Dell,7440\n");
    expect((await get("Bearer anything")).status).toBe(401);
  });

  it("imports the linked CSV and attributes it to the service account", async () => {
    mockDrive("serialNumber,make,model\nDRIVE-1,Dell,7440\n");
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: "imported", added: 1 });

    const item = await prisma.item.findFirst({ where: { serialNumber: "DRIVE-1" } });
    expect(item).not.toBeNull();
    const svc = await prisma.user.findUnique({ where: { email: IMPORT_SERVICE_ACCOUNT_EMAIL } });
    expect(item!.createdById).toBe(svc!.id);

    const batch = await prisma.importBatch.findFirst();
    expect(batch!.sourceHash).toEqual(expect.any(String));
    expect(revalidatePath).toHaveBeenCalledWith("/items");
  });

  it("skips a byte-identical second run without writing another batch", async () => {
    const csv = "serialNumber,make,model\nDRIVE-2,Dell,7440\n";
    mockDrive(csv);
    expect((await get(`Bearer ${SECRET}`)).status).toBe(200);

    // Cleared so the assertion below is about the SECOND run only — the first
    // one imported and revalidated correctly.
    revalidatePath.mockClear();

    mockDrive(csv);
    const second = await get(`Bearer ${SECRET}`);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, status: "unchanged" });

    // One batch, not two: the skip happens before any transaction opens.
    expect(await prisma.importBatch.count()).toBe(1);
    // ...and no cache churn on a quiet morning.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("imports again once the export actually changes", async () => {
    mockDrive("serialNumber,make,model\nDRIVE-3,Dell,7440\n");
    await get(`Bearer ${SECRET}`);

    mockDrive("serialNumber,make,model\nDRIVE-3,Dell,7440\nDRIVE-4,Dell,7450\n");
    const res = await get(`Bearer ${SECRET}`);
    expect(await res.json()).toMatchObject({ status: "imported", added: 1 });
    expect(await prisma.importBatch.count()).toBe(2);
  });

  // The whole reason checkDriveCsvBody exists. A revoked share answers 200 with
  // an HTML sign-in page; parsed as CSV that is zero rows, which is identical to
  // "nothing changed" — so without this the job would report success forever
  // while the property book silently went stale.
  it("refuses an HTML sign-in page served with HTTP 200", async () => {
    mockDrive('<!DOCTYPE html><html><title>Sign in - Google Accounts</title></html>', {
      contentType: "text/html; charset=utf-8",
    });
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/not a CSV/i);
    expect(await prisma.importBatch.count()).toBe(0);
  });

  // This is Drive's REAL response for a missing or unreadable file, measured
  // against the live endpoint on 2026-08-10: a 303 to
  // drive.usercontent.google.com, then 404 with an HTML body. Status is caught
  // before the body ever matters — the HTML check above is the backstop for the
  // unreadable states that answer 200 instead.
  it("reports an upstream HTTP error rather than importing nothing quietly", async () => {
    mockDrive('<html><title>Error 404 (Not Found)!!1</title></html>', {
      status: 404,
      contentType: "text/html; charset=utf-8",
    });
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/404/);
    expect(await prisma.importBatch.count()).toBe(0);
  });

  it("reports `disabled` — never a false success — when DRIVE_CSV_URL is unset", async () => {
    delete process.env.DRIVE_CSV_URL;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "disabled" });
    // Nothing was even attempted; the scheduling workflow turns this into a
    // red run so the misconfiguration cannot sit green.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a plaintext http:// source", async () => {
    process.env.DRIVE_CSV_URL = "http://drive.example.test/uc?id=X";
    mockDrive("serialNumber,make,model\nDRIVE-5,Dell,7440\n");
    const res = await get(`Bearer ${SECRET}`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/https/i);
  });
});
