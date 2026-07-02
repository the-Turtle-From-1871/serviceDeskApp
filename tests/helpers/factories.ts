import prisma from "@/lib/prisma";

let n = 0;

export function makeUser(
  overrides: Partial<{
    name: string;
    role: "ADMIN" | "USER";
    isActive: boolean;
    unit: string;
    contactNumber: string;
  }> = {}
) {
  n += 1;
  return prisma.user.create({
    data: {
      name: overrides.name ?? `User${n}`,
      email: `user${n}@x.co`,
      passwordHash: "x",
      role: overrides.role ?? "USER",
      isActive: overrides.isActive ?? true,
      unit: overrides.unit,
      contactNumber: overrides.contactNumber,
    },
  });
}

export function makeItem(
  createdById: string,
  overrides: Partial<{ homeUnit: string; notes: string; status: "ACTIVE" | "RETIRED" }> = {}
) {
  n += 1;
  return prisma.item.create({
    data: {
      make: "Make",
      model: "Model",
      serialNumber: `SN${n}`,
      createdById,
      homeUnit: overrides.homeUnit,
      notes: overrides.notes,
      status: overrides.status ?? "ACTIVE",
    },
  });
}

export function makeTransfer(
  itemId: string,
  overrides: Partial<{
    itemSummary: string;
    senderIsDcsim: boolean;
    senderName: string;
    receiverIsDcsim: boolean;
    receiverName: string;
    receiverSignature: string;
    status: "COMPLETED" | "VOID";
    createdByUserId: string;
  }> = {}
) {
  n += 1;
  return prisma.transfer.create({
    data: {
      receiptNumber: `HR-TEST${n}`,
      itemId,
      itemSummary: overrides.itemSummary ?? "Make Model (SN SN1)",
      senderIsDcsim: overrides.senderIsDcsim ?? true,
      senderName: overrides.senderName ?? "DCSIM Tech",
      receiverIsDcsim: overrides.receiverIsDcsim ?? false,
      receiverName: overrides.receiverName ?? `Receiver${n}`,
      receiverSignature: overrides.receiverSignature ?? "data:image/png;base64,AAAA",
      status: overrides.status ?? "COMPLETED",
      createdByUserId: overrides.createdByUserId,
    },
  });
}
