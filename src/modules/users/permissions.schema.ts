import { z } from "zod";
import { CAPABILITIES, isRequestable } from "./capabilities";

// Long enough to be a reason rather than a shrug. An admin deciding a request
// has only this text to go on, so "pls" must not be submittable.
export const MIN_JUSTIFICATION = 20;
const MAX_TEXT = 2000;

const requestableCapability = z
  .enum(CAPABILITIES)
  .refine(isRequestable, "That permission cannot be requested.");

export const permissionRequestSchema = z.object({
  justification: z
    .string()
    .trim()
    .min(
      MIN_JUSTIFICATION,
      `Please explain what you need this for (at least ${MIN_JUSTIFICATION} characters).`,
    )
    .max(MAX_TEXT),
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
