import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    serviceQueueItem: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  },
}));

import prisma from "@/lib/prisma";
import { sendOverdueServiceAlerts } from "./timer-alert.service";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { process.env = { ...orig }; });

const NOW = new Date("2026-07-17T00:00:00.000Z");
const row = {
  id: "sq1", serviceType: "REIMAGE", serviceNote: null, dueAt: new Date("2026-07-14T00:00:00.000Z"),
  item: { serialNumber: "SN9", deviceName: "LT-9", homeUnit: "A Co" },
};

describe("sendOverdueServiceAlerts", () => {
  it("emails the admin inbox once and stamps overdueAlertedAt", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    vi.mocked(prisma.serviceQueueItem.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueServiceAlerts(NOW, { sender: { send } });
    expect(prisma.serviceQueueItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "PENDING", dueAt: { not: null, lte: NOW }, overdueAlertedAt: null },
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@army.mil");
    expect(send.mock.calls[0][0].text).toContain("SN9");
    expect(prisma.serviceQueueItem.update).toHaveBeenCalledWith({ where: { id: "sq1" }, data: { overdueAlertedAt: NOW } });
    expect(res.alertedCount).toBe(1);
  });

  it("does nothing when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    vi.mocked(prisma.serviceQueueItem.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueServiceAlerts(NOW, { sender: { send } });
    expect(send).not.toHaveBeenCalled();
    expect(res.alertedCount).toBe(0);
  });
});
