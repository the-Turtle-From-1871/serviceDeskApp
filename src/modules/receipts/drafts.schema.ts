import { z } from "zod";
import { MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";

// A saved draft is an INCOMPLETE receipt, so this schema is deliberately NOT
// `receiptSchema`. That one describes a receipt that is ready to file — every
// required party field present, a signature attached. This one accepts whatever
// the operator had typed when they hit Save, including nothing at all.
//
// What it still does is BOUND everything, because `ReceiptDraft.payload` is a
// user-writable Json column: without caps a crafted POST could store megabytes.
// Every field is capped, both arrays are capped, and z.object() strips unknown
// keys (which is what keeps `receiverSignature` out even though the form posts
// it — see the no-signature rule in the design spec).

const NAME_MAX = 200;
const SHORT_MAX = 120;
const NOTE_MAX = 500;
const ID_MAX = 64;
const NUMERIC_MAX = 10; // "3650" and friends; these stay strings, see below

/** Trimmed, capped, and defaulting to "" — a draft keeps blanks as blanks. */
const text = (max: number) => z.string().trim().max(max).default("");

// NOT `as const`: this is passed to Zod's `.default()`, which wants a mutable
// object matching the schema's input type — a readonly literal fights it.
export const EMPTY_DRAFT_PARTY = {
  isDcsim: false, name: "", rank: "", unit: "", contact: "", email: "",
};

const draftPartySchema = z.object({
  isDcsim: z.boolean().default(false),
  name: text(NAME_MAX),
  rank: text(SHORT_MAX),
  unit: text(SHORT_MAX),
  contact: text(SHORT_MAX),
  email: text(SHORT_MAX),
});

// Quantities stay STRINGS. The builder's inputs are controlled strings, and a
// draft should restore exactly what was typed — coercing to a number here would
// turn a half-typed "" into 0 and restore a quantity the operator never entered.
// Coercion happens at FILE time, in receiptSchema, where it belongs.
const draftLineSchema = z.object({
  make: text(SHORT_MAX),
  model: text(SHORT_MAX),
  qtyAuth: text(NUMERIC_MAX),
  qtyIssued: text(NUMERIC_MAX),
});

const draftServiceSchema = z.object({
  itemId: z.string().trim().min(1).max(ID_MAX),
  serviceType: z.enum(["REIMAGE", "REPAIR", "OTHER"]),
  note: text(NOTE_MAX),
  days: text(NUMERIC_MAX),
});

export const receiptDraftSchema = z.object({
  itemIds: z.array(z.string().trim().min(1).max(ID_MAX)).max(MAX_RECEIPT_ROWS * MAX_ITEMS_PER_ROW).default([]),
  lines: z.array(draftLineSchema).max(MAX_RECEIPT_ROWS).default([]),
  sender: draftPartySchema.default(EMPTY_DRAFT_PARTY),
  receiver: draftPartySchema.default(EMPTY_DRAFT_PARTY),
  returnDays: text(NUMERIC_MAX),
  service: z.array(draftServiceSchema).max(MAX_RECEIPT_ROWS * MAX_ITEMS_PER_ROW).default([]),
});

export type ReceiptDraftPayload = z.infer<typeof receiptDraftSchema>;

/** The auto-label shown in the account list. Derived, never user-supplied —
 *  there is no name field to fill on a phone mid-scan.
 *
 *  Takes the two values rather than a payload, because `listDrafts` renders the
 *  list from the DENORMALIZED columns and must not deserialize a payload just to
 *  build a label. One definition of the wording, two callers. */
export function formatDraftLabel(recipientName: string | null, itemCount: number): string {
  return `${recipientName || "No recipient yet"} · ${itemCount} item${itemCount === 1 ? "" : "s"}`;
}

export function draftLabel(p: ReceiptDraftPayload): string {
  return formatDraftLabel(p.receiver.name || null, p.itemIds.length);
}
