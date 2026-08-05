import { z } from "zod";
import { signatureError } from "@/lib/signature";

// Image validation delegates to the shared `signatureError` (PNG data-URL prefix
// + MAX_SIGNATURE_LEN, 250 KB), as do the account and returns paths.
//
// NOT every signature path, despite what this comment used to claim: the RECEIPT
// path (`receiverSignature` in transfers.schema.ts) skips `signatureError` and
// caps at MAX_SIGNATURE_BYTES = 5 MB — 20x larger, on the one signature whose
// output is publicly reachable via /receipts/<n>/pdf. That asymmetry is finding
// F3 / gap U10 of the 2026-08-05 security assessment, still open. When it is
// closed by routing the receipt path through `signatureError`, restore the
// stronger wording here.
export const newSignatureSchema = z.object({
  name: z.string().trim().min(1, "A name is required"),
  image: z.string().superRefine((v, ctx) => {
    const err = signatureError(v);
    if (err) ctx.addIssue({ code: "custom", message: err });
  }),
});

export type NewSignatureInput = z.infer<typeof newSignatureSchema>;
