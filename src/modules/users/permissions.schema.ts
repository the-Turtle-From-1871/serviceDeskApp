import { z } from "zod";
import { CAPABILITIES, isRequestable } from "./capabilities";

const MAX_TEXT = 2000;

const requestableCapability = z
  .enum(CAPABILITIES)
  .refine(isRequestable, "That permission cannot be requested.");

export const permissionRequestSchema = z.object({
  // Any length, including none at all.
  //
  // This carried a 20-character floor on the theory that an admin deciding a
  // request has only this text to go on, so "pls" should not be submittable.
  // In practice the floor blocked the requests it was meant to improve: the
  // people asking are colleagues down the hall who have usually already had the
  // conversation, and a form that refuses "taking over returns" is a form they
  // abandon. A thin justification an admin can weigh beats a request never
  // filed. The admin still decides, and can still deny with a reason.
  //
  // `.default("")` so an omitted field parses as empty rather than throwing —
  // the action always sends a string, but the schema is the contract. Trimmed,
  // so a whitespace-only submission is stored as "" instead of masquerading as
  // text; the two surfaces that render it check for empty. `.max()` stays: the
  // column is unbounded, and 2000 characters is already a long reason.
  justification: z.string().trim().max(MAX_TEXT).default(""),
  capabilities: z
    .array(requestableCapability)
    .min(1, "Choose at least one permission to request.")
    // Deduped here so a crafted POST repeating one capability cannot create
    // duplicate request lines — the DB's @@unique would reject the write, but a
    // form error is a poor way to learn that.
    .transform((v) => [...new Set(v)]),
});

export type PermissionRequestInput = z.infer<typeof permissionRequestSchema>;

export const permissionDecisionSchema = z.object({
  requestId: z.string().min(1),
  // The CHECKED lines only. Everything else on the request is DENIED — the
  // admin decides by unchecking, so an absent capability is a decision, not an
  // omission. Defaults to an empty array, which is a full denial.
  approve: z
    .array(z.enum(CAPABILITIES))
    .default([])
    .transform((v) => [...new Set(v)]),
  denialReason: z.string().trim().max(MAX_TEXT).optional(),
});

export type PermissionDecisionInput = z.infer<typeof permissionDecisionSchema>;
