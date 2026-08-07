import { notFound } from "next/navigation";
import { requireUser } from "@/lib/authz";
import { getItem } from "@/modules/items/items.service";
import { getLastReceiver } from "@/modules/transfers/transfers.service";
import { groupItemsIntoLines, MAX_RECEIPT_ROWS, MAX_ITEMS_PER_ROW } from "@/modules/transfers/receipt-lines";
import { listSignatures } from "@/modules/signatures/signatures.service";
import { SiteHeader } from "@/components/SiteHeader";
import { ReceiptBuilderForm } from "./ReceiptBuilderForm";
import { getDraft } from "@/modules/receipts/drafts.service";
import { DraftError } from "@/modules/receipts/drafts.errors";
import { splitDraftItems, formatDroppedItemsNotice, type DroppedDraftItem } from "@/modules/receipts/drafts.resume";
import { deleteDraftAction } from "@/app/actions/drafts";

// Shared by every terminal ("can't be resumed") card below, so a technician
// stuck on one of them always has the same way out: delete the draft, same as
// the /account list's own Delete button (DraftList.tsx), posting to the same
// action. Per design spec §4.4 — a terminal card must never leave the operator
// with nothing to do but navigate away by hand.
function DeleteDraftForm({ draftId }: { draftId: string }) {
  return (
    <form action={deleteDraftAction}>
      <input type="hidden" name="id" value={draftId} />
      <button type="submit" className="btn btn-secondary" style={{ minHeight: "var(--tap)" }}>
        Delete this draft
      </button>
    </form>
  );
}

export default async function NewReceiptPage({ searchParams }: { searchParams: Promise<{ items?: string; draft?: string }> }) {
  const user = await requireUser();
  const { items: itemsParam, draft: draftParam } = await searchParams;

  // Resuming a saved draft. Scoped to the acting user inside getDraft, so
  // another technician's id 404s rather than opening their work.
  let draft: Awaited<ReturnType<typeof getDraft>> = null;
  if (draftParam) {
    try {
      draft = await getDraft(draftParam, user.id);
    } catch (e) {
      if (e instanceof DraftError && e.code === "CORRUPT") {
        return (
          <>
            <SiteHeader />
            <main className="container container-mid stack">
              <h1 className="page-title">New hand receipt</h1>
              <div className="card empty stack-sm">
                <p>This draft can no longer be read and should be deleted.</p>
                {/* `draft` is never assigned on this path (the throw happens
                    before the assignment completes), but `draftParam` — the id
                    from the URL — is exactly what a delete needs. */}
                <DeleteDraftForm draftId={draftParam} />
              </div>
            </main>
          </>
        );
      }
      throw e;
    }
    if (!draft) notFound();
  }

  // The URL wins over the draft payload when both are present. Resuming from
  // /account carries no `?items=`, so the payload still seeds the first
  // render — but once mounted, ReceiptBuilderForm's `replaceState` effect keeps
  // the URL in step with the LIVE item list (including anything scanned after
  // resuming), and that URL must win on a reload or a post-resume scan is
  // silently discarded — the exact tab-eviction scenario that effect exists to
  // survive.
  const parsedItems = (itemsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = draft ? (parsedItems.length ? parsedItems : draft.payload.itemIds) : parsedItems;

  // A draft can be SAVED with zero items — `removeItem` can empty the builder's
  // list before "Save draft" is clicked, and `receiptDraftSchema` permits
  // `itemIds: []`. Resuming one must never fall through to the bare
  // `notFound()` below: per spec §4.4, never an empty builder and never a bare
  // 404 for a draft — always an explanatory card with a way out.
  if (draft && ids.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="container container-mid stack">
          <h1 className="page-title">New hand receipt</h1>
          <div className="card empty stack-sm">
            <p>This draft has no items saved and can&apos;t be resumed. Delete it and start a new hand receipt.</p>
            <DeleteDraftForm draftId={draft.id} />
          </div>
        </main>
      </>
    );
  }
  if (ids.length === 0) notFound();

  // Kept alongside `loaded` (not discarded) so a dropped item can be NAMED:
  // `null` means the id no longer resolves to any row at all (deleted from
  // inventory outright); a non-null, non-ACTIVE row means retired — and in
  // either case it was already fetched, so naming it costs no extra query.
  const fetched = await Promise.all(ids.map((id) => getItem(id)));
  const loaded = fetched.filter((i) => i && i.status === "ACTIVE") as NonNullable<Awaited<ReturnType<typeof getItem>>>[];

  // A draft whose devices have ALL since been retired or deleted must say so.
  // Falling through to notFound() would read as "your draft vanished".
  if (draft && loaded.length === 0) {
    return (
      <>
        <SiteHeader />
        <main className="container container-mid stack">
          <h1 className="page-title">New hand receipt</h1>
          <div className="card empty stack-sm">
            <p>
              None of the {ids.length} device{ids.length === 1 ? "" : "s"} on this draft can be issued any
              more — they have been retired or removed from inventory. Delete the draft and start again.
            </p>
            <DeleteDraftForm draftId={draft.id} />
          </div>
        </main>
      </>
    );
  }
  if (loaded.length === 0) notFound();

  // Only meaningful when resuming a draft — with no draft, `ids` is just
  // whatever the caller put in `?items=` and every one of them is either
  // loaded or excluded already; there is no "dropped from the draft" story to
  // tell. Without gating on `draft`, a plain `/receipts/new?items=<retired>,<active>`
  // link (reachable from `/items` when a device is retired between page load
  // and click) rendered a draft-worded "removed from this draft" alert with no
  // draft in play.
  const { droppedIds } = splitDraftItems(ids, loaded);
  // `fetched` is index-aligned with `ids` (Promise.all preserves order), so a
  // dropped id's fetch result — whether a retired row or `null` — is a direct
  // lookup here. Per §4 of the design spec, the banner must NAME what it can
  // (serial + make/model of a retired item) rather than a bare count.
  const fetchedById = new Map(ids.map((id, i) => [id, fetched[i]]));
  const dropped: DroppedDraftItem[] = droppedIds.map((id) => {
    const item = fetchedById.get(id);
    return item ? { id, serialNumber: item.serialNumber, make: item.make, model: item.model } : { id };
  });
  const droppedItemsNotice = draft ? formatDroppedItemsNotice(dropped) : "";

  const lines = groupItemsIntoLines(loaded.map((i) => ({ itemId: i.id, make: i.make, model: i.model, serialNumber: i.serialNumber })));
  const tooMany = lines.length > MAX_RECEIPT_ROWS;
  const tooManyPerRow = lines.some((l) => l.serials.length > MAX_ITEMS_PER_ROW);

  // Named signatures are an ADMIN capability, so gate on the ROLE — not on
  // "a non-admin happens to own no rows". A demoted admin keeps their Signature
  // rows (nothing deletes them; the FK only cascades on user deletion), so an
  // ownership-only check would leave them the capability after it was revoked.
  // Mirrors account/page.tsx:22. Also keeps every signature image out of the
  // RSC payload for users who can never use one.
  //
  // Sender prefill only when every item shares an identical last receiver.
  const [signatures, lastReceivers] = await Promise.all([
    user.role === "ADMIN" ? listSignatures(user.id) : Promise.resolve([]),
    Promise.all(loaded.map((i) => getLastReceiver(i.id))),
  ]);
  const first = lastReceivers[0];
  const allSame = first != null && lastReceivers.every((r) => r && JSON.stringify(r) === JSON.stringify(first));
  const senderPrefill = allSame
    ? (first!.isDcsim ? { isDcsim: true, name: first!.name } : { isDcsim: false, name: first!.name, rank: first!.rank ?? "", unit: first!.unit ?? "", contact: first!.contact ?? "", email: first!.email ?? "" })
    : undefined;

  return (
    <>
      <SiteHeader />
      {/* container-wide (not -mid) so each item's row — serial, the inline
          "Needs service?" controls, and the qty inputs — fits on ONE line on a
          desktop instead of wrapping into a ~143px-tall stack. Matches the Items
          list and the site header, which are already wide. */}
      <main className="container container-wide stack">
        {tooMany ? (
          <>
            <h1 className="page-title">New hand receipt</h1>
            <div className="card empty">This selection has {lines.length} item types — the form holds {MAX_RECEIPT_ROWS}. Split it into two receipts.</div>
          </>
        ) : tooManyPerRow ? (
          <>
            <h1 className="page-title">New hand receipt</h1>
            <div className="card empty">One item type has more than {MAX_ITEMS_PER_ROW} items on a single row. Split that item across two receipts.</div>
          </>
        ) : (
          <ReceiptBuilderForm
            initialItems={loaded.map((i, k) => ({
              itemId: i.id,
              make: i.make,
              model: i.model,
              serialNumber: i.serialNumber,
              // The item's CURRENT holder, already fetched at line 34
              // (`lastReceivers`, index-aligned with `loaded`). Do NOT hardcode
              // null: `senderPrefill` is derived from these items ONLY when every
              // holder matches (`allSame`, lines 38-41) — when holders DIFFER the
              // prefill is undefined and the operator types a sender that can
              // absolutely disagree with them. And `replaceState` now feeds every
              // SCANNED item back into `?items=`, so a mixed-holder list reaches
              // this page through the URL on an iOS reload — exactly the reload
              // the sync exists to survive. Discarding holderName here would drop
              // the spec's persistent warning on precisely that path.
              holderName: lastReceivers[k]?.name ?? null,
            }))}
            senderPrefill={draft ? undefined : senderPrefill}
            signatures={signatures}
            draftId={draft?.id}
            draftValues={draft?.payload}
            droppedItemsNotice={droppedItemsNotice}
          />
        )}
      </main>
    </>
  );
}
