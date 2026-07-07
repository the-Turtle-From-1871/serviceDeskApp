import { z } from "zod";
import { MAX_RECEIPT_ROWS } from "./receipt-lines";

export const SIGNATURE_PREFIX = "data:image/png;base64,";
export const MAX_SIGNATURE_BYTES = 5_000_000;

const trimmedString = z.string().trim();

// NOTE: `.optional()` must be the OUTERMOST wrapper (applied after any
// `.transform()`), not the innermost. Zod's object-key-optionality check
// looks for a top-level ZodOptional; a `.transform()`/`.or()` on the outside
// hides that from the object schema, so the inferred object key becomes
// REQUIRED (typed `string | undefined`) instead of OPTIONAL (`string?`).
// See Context7 zod v4 docs (zod.dev/v4): `.transform()` produces a
// ZodPipe/ZodEffects wrapper, and only a schema whose outermost type is
// ZodOptional (or ZodDefault) is treated as an optional object key.
const optional = trimmedString.transform((v) => v || undefined).optional();

const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const partySchema = z
  .object({
    isDcsim: z.boolean(),
    name: z.string().trim().min(1, "Name is required"),
    rank: optional,
    unit: optional,
    contact: optional,
    email: trimmedString.transform((v) => (v ? v.toLowerCase() : undefined)).optional(),
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

const positiveInt = z.coerce.number().int().positive();

export const lineQtySchema = z.object({
  make: z.string().trim().min(1),
  model: z.string().trim().min(1),
  qtyAuth: positiveInt,
  qtyIssued: positiveInt,
});
export type LineQtyInput = z.infer<typeof lineQtySchema>;

export const receiptSchema = z
  .object({
    itemIds: z.array(z.string().min(1)).min(1, "Select at least one item"),
    lines: z.array(lineQtySchema).min(1).max(MAX_RECEIPT_ROWS, "Too many item types for one receipt"),
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
export type ReceiptInput = z.infer<typeof receiptSchema>;
