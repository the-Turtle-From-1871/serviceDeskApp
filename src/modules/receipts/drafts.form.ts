import { parseReceiptForm } from "@/app/actions/receipts.parse";
import { parseServiceMap } from "@/modules/service-queue/service-form";

// Build the draft payload from the SAME FormData the Create button posts.
// "Save draft" is a second submit button on the builder form (formAction +
// formNoValidate), so there is exactly one definition of what is on a receipt —
// the form itself — and a draft cannot drift from what would be filed.
//
// `receiverSignature` is deliberately dropped here AND absent from
// receiptDraftSchema, which strips unknown keys. Two independent barriers,
// because a signature attests to a specific item list and must never be
// restored onto a list that has since changed.
//
// NOT in actions/drafts.ts: a file-level "use server" makes every export a
// network-callable Server Function, which must be async. This is synchronous
// pure parsing and has no business being an endpoint.
export function draftPayloadFromForm(formData: FormData) {
  const raw = parseReceiptForm(formData);
  // parseServiceMap keeps only rows whose "Needs service?" was actually
  // checked, and normalises the day count. An invalid days value ("abc",
  // "5000") therefore does not survive into the draft — it would not survive
  // filing either, so the draft matches what the receipt would do.
  const service = [...parseServiceMap(formData)].map(([itemId, sel]) => ({
    itemId,
    serviceType: sel.serviceType,
    note: sel.note ?? "",
    days: sel.overrideDays == null ? "" : String(sel.overrideDays),
  }));
  return {
    itemIds: raw.itemIds,
    lines: raw.lines,
    sender: raw.sender,
    receiver: raw.receiver,
    returnDays: raw.returnDays,
    service,
  };
}
