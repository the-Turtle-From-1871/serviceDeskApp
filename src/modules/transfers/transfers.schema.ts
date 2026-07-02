import { z } from "zod";

export const SIGNATURE_PREFIX = "data:image/png;base64,";
export const MAX_SIGNATURE_BYTES = 5_000_000;

const optional = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((v) => v || undefined);

const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const partySchema = z
  .object({
    isDcsim: z.boolean(),
    name: z.string().trim().min(1, "Name is required"),
    rank: optional,
    unit: optional,
    contact: optional,
    email: optional.transform((v) => (v ? v.toLowerCase() : undefined)),
  })
  .superRefine((p, ctx) => {
    if (p.isDcsim) return; // DCSIM side only needs a technician name
    const required = ["rank", "unit", "contact", "email"] as const;
    for (const f of required) {
      if (!p[f]) ctx.addIssue({ code: "custom", path: [f], message: `${f} is required` });
    }
    if (p.email && !emailRe.test(p.email)) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "A valid email is required" });
    }
  });

export type PartyInput = z.infer<typeof partySchema>;

export const transferSchema = z
  .object({
    itemId: z.string().min(1, "An item is required"),
    sender: partySchema,
    receiver: partySchema,
    receiverSignature: z
      .string()
      .startsWith(SIGNATURE_PREFIX, "Recipient signature is required")
      .max(MAX_SIGNATURE_BYTES, "Signature is too large"),
  })
  .superRefine((t, ctx) => {
    if (t.sender.isDcsim && t.receiver.isDcsim) {
      ctx.addIssue({ code: "custom", path: ["receiver", "isDcsim"], message: "Both parties cannot be DCSIM" });
    }
  });

export type TransferInput = z.infer<typeof transferSchema>;
