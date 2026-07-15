import { z } from "zod";
import { signatureError } from "@/lib/signature";

// Image validation delegates to the shared `signatureError` (PNG data-URL prefix
// + MAX_SIGNATURE_LEN) so saved signatures obey the same rule as every other
// signature in the app.
export const newSignatureSchema = z.object({
  name: z.string().trim().min(1, "A name is required"),
  image: z.string().superRefine((v, ctx) => {
    const err = signatureError(v);
    if (err) ctx.addIssue({ code: "custom", message: err });
  }),
});

export type NewSignatureInput = z.infer<typeof newSignatureSchema>;
