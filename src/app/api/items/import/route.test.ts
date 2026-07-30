import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import prisma from "@/lib/prisma";

// `revalidatePath` needs a Next.js request-scoped store that only exists
// inside a real server render/request; calling the route handler directly
// (as this test does, importing POST and invoking it outside Next) throws
// "Invariant: static generation store missing". Stub it the same way the
// Server Action tests do (see src/app/actions/items.test.ts) — this is a
// test-environment limitation, not a change to what the route does when
// Next actually serves it.
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

import { POST } from "./route";

const SECRET = "test-import-secret";

const post = (body: FormData | null, auth?: string) =>
  POST(
    new Request("https://example.test/api/items/import", {
      method: "POST",
      headers: auth ? { authorization: auth } : undefined,
      body: body ?? undefined,
    }) as never,
  );

const csvForm = (csv: string, filename = "fleet.csv") => {
  const fd = new FormData();
  fd.set("file", new File([csv], filename, { type: "text/csv" }));
  return fd;
};

// Captured and restored rather than just set: `fileParallelism: false` means
// this whole suite shares one worker with every other test file, so leaving
// MDM_IMPORT_SECRET set after this file finishes would leak "test-import-secret"
// into any later file that reads process.env.MDM_IMPORT_SECRET.
const priorSecret = process.env.MDM_IMPORT_SECRET;

beforeAll(() => {
  process.env.MDM_IMPORT_SECRET = SECRET;
});

afterAll(() => {
  if (priorSecret === undefined) delete process.env.MDM_IMPORT_SECRET;
  else process.env.MDM_IMPORT_SECRET = priorSecret;
});

describe("POST /api/items/import", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await post(csvForm("serialNumber\nX1"));
    expect(res.status).toBe(401);
    expect(await prisma.item.count({ where: { serialNumber: "X1" } })).toBe(0);
  });

  it("rejects a wrong secret and imports nothing", async () => {
    const res = await post(csvForm("serialNumber,make,model\nX2,Dell,7440"), "Bearer wrong");
    expect(res.status).toBe(401);
    expect(await prisma.item.count({ where: { serialNumber: "X2" } })).toBe(0);
  });

  it("rejects a non-csv filename", async () => {
    const res = await post(csvForm("serialNumber\nX3", "fleet.txt"), `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
  });

  it("imports a valid CSV and attributes it to the service account", async () => {
    const res = await post(
      csvForm("serialNumber,make,model\nROUTE-1,Dell,7440"),
      `Bearer ${SECRET}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(1);

    const item = await prisma.item.findFirst({ where: { serialNumber: "ROUTE-1" } });
    expect(item).not.toBeNull();

    const batch = await prisma.importBatch.findFirst({
      where: { filename: "fleet.csv" },
      orderBy: { createdAt: "desc" },
      include: { createdBy: { select: { email: true } } },
    });
    expect(batch?.createdBy.email).toBe("mdm-import@service.invalid");
    expect(revalidatePath).toHaveBeenCalledWith("/items");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/audit");
  });

  it("returns 400 with a message on an unparseable CSV rather than throwing", async () => {
    const res = await post(csvForm("not,a,fleet,export\n1,2,3,4"), `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });
});
