"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/authz";
import { setPin } from "@/lib/public-access";

const schema = z
  .object({
    pin: z.string().regex(/^\d{8}$/, "PIN must be exactly 8 digits."),
    confirm: z.string(),
  })
  .refine((d) => d.pin === d.confirm, { message: "PINs do not match.", path: ["confirm"] });

export async function setPublicAccessPinAction(_prev: unknown, formData: FormData) {
  const admin = await requireAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  await setPin(parsed.data.pin, admin.id);
  revalidatePath("/admin");
  return { ok: true };
}
