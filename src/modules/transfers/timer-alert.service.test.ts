import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  default: {
    transfer: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
  },
}));

import prisma from "@/lib/prisma";
import { sendOverdueTransferAlerts } from "./timer-alert.service";
import type { EmailMessage } from "@/lib/email";

const orig = { ...process.env };
beforeEach(() => vi.clearAllMocks());
afterEach(() => { process.env = { ...orig }; });

const NOW = new Date("2026-07-17T00:00:00.000Z");
const row = { id: "t1", receiptNumber: "HR-000001", itemSummary: "Dell Latitude (SN X)", dueAt: new Date("2026-07-10T00:00:00.000Z") };

describe("sendOverdueTransferAlerts", () => {
  it("emails the admin inbox once and stamps overdueAlertedAt", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    vi.mocked(prisma.transfer.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueTransferAlerts(NOW, { sender: { send } });
    expect(prisma.transfer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "OPEN", dueAt: { not: null, lte: NOW }, overdueAlertedAt: null },
    }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("admin@army.mil");
    expect(send.mock.calls[0][0].subject).toContain("HR-000001");
    expect(prisma.transfer.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { overdueAlertedAt: NOW } });
    expect(res.alertedCount).toBe(1);
  });

  it("does nothing when ADMIN_INBOX_EMAIL is unset", async () => {
    delete process.env.ADMIN_INBOX_EMAIL;
    vi.mocked(prisma.transfer.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => {});
    const res = await sendOverdueTransferAlerts(NOW, { sender: { send } });
    expect(send).not.toHaveBeenCalled();
    expect(prisma.transfer.update).not.toHaveBeenCalled();
    expect(res.alertedCount).toBe(0);
  });

  it("does not stamp when the send fails", async () => {
    process.env.ADMIN_INBOX_EMAIL = "admin@army.mil";
    vi.mocked(prisma.transfer.findMany).mockResolvedValueOnce([row] as never);
    const send = vi.fn(async (_m: EmailMessage) => { throw new Error("boom"); });
    const res = await sendOverdueTransferAlerts(NOW, { sender: { send } });
    expect(prisma.transfer.update).not.toHaveBeenCalled();
    expect(res.alertedCount).toBe(0);
  });
});
