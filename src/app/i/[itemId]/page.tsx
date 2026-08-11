import Link from "next/link";
import { notFound } from "next/navigation";
import { getItemWithCreator, listItemFieldSuggestions } from "@/modules/items/items.service";
import { readinessForItem } from "@/modules/items/readiness.query";
import { READINESS_LABEL } from "@/modules/items/readiness";
import { MarkReadyButton } from "@/components/MarkReadyButton";
import { ReadinessControls } from "@/components/ReadinessControls";
import { listReceiptsForItem, getHoldingTransfer } from "@/modules/transfers/transfers.service";
import { formatParty } from "@/modules/transfers/party";
import { itemQrDataUrl, itemUrl } from "@/modules/items/qr";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDateTimeHST } from "@/lib/datetime";
import { SiteHeader } from "@/components/SiteHeader";
import { getCurrentUser } from "@/lib/session";
import { getServiceRequestForItem } from "@/modules/service-queue/service-queue.service";
import { serviceTypeLabel } from "@/modules/service-queue/service-queue.status";
import { ServiceControls } from "./ServiceControls";
import prisma from "@/lib/prisma";
import { listUnits } from "@/modules/items/units.service";
import { listCategoryNames } from "@/modules/items/categories.service";
import { ItemDetailsCard } from "./ItemDetailsCard";
import { getAuditsForItem } from "@/modules/audit/audit.service";
import { listSignatures } from "@/modules/signatures/signatures.service";
import { auditState, auditStateDisplay } from "@/modules/audit/audit.status";
import { AuditLight } from "@/components/AuditLight";
import { AuditControls } from "./AuditControls";
import { AuditSignatureReveal } from "./AuditSignatureReveal";
import { DueBadge } from "@/components/DueBadge";

export default async function PublicItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  // All fetches depend only on itemId (known up front), so run them together.
  const [item, user, receipts, currentHolder, qr, service, lastEdit, audits, readiness] = await Promise.all([
    getItemWithCreator(itemId),
    getCurrentUser(),
    listReceiptsForItem(itemId),
    // Custody is NOT `receipts.find(t => t.status === "OPEN")`: a PARTIAL return
    // leaves the receipt OPEN, so that would still name the customer as holding
    // an item they already handed back. getHoldingTransfer checks this item's
    // own returnedAt.
    getHoldingTransfer(itemId),
    // Fetched for everyone even though only admins render it (below). Moving it
    // behind the role check would serialise it after getCurrentUser and slow the
    // admin path, to save a call that is memoized across requests and deploys
    // (unstable_cache in qr.ts) — the QR for an item id never changes.
    itemQrDataUrl(itemId).catch((e) => { console.error("[item-page] QR generation failed:", e); return ""; }),
    getServiceRequestForItem(itemId),
    prisma.itemEdit.findFirst({ where: { itemId }, orderBy: { createdAt: "desc" } }),
    getAuditsForItem(itemId),
    // Readiness is derived, and deliberately from the SAME SQL the dashboard
    // and the /items list use rather than re-deriving it here from `service`
    // and `currentHolder`. Those two are close but not identical inputs
    // (getHoldingTransfer only inspects the item's LATEST receipt), so
    // recomputing locally is exactly how the item page and the fleet numbers
    // would start disagreeing.
    readinessForItem(itemId),
  ]);
  if (!item) notFound();
  const loggedIn = !!user && user.isActive;
  const isAdmin = user?.role === "ADMIN";
  // All admin-only inputs to the cards below, so none of these queries run for
  // anyone else; when they do run they run together, not one after the other.
  // `/i/<id>` is public — an unguarded fetch here would ship the unit and UIC
  // catalogue to a logged-out visitor even though the fields that use them are
  // admin-only.
  const [signatures, units, categories, suggestions] = await Promise.all([
    isAdmin && item.status === "ACTIVE" ? listSignatures(user!.id) : [],
    isAdmin ? listUnits() : [],
    // The picker offers the MANAGED vocabulary, not whatever strings happen to
    // be on items — same source as the admin edit page.
    isAdmin ? listCategoryNames() : [],
    isAdmin ? listItemFieldSuggestions() : { make: [], model: [], deviceUIC: [], storageLocation: [] },
  ]);
  const now = new Date();
  const auditLightState = item.status === "RETIRED" ? null : auditState(audits[0]?.createdAt ?? null, now);
  return (
    <>
      <SiteHeader />
      <main className="container container-mid stack">
        <div className="row">
          <div>
            <h1 className="page-title">{item.make} {item.model}</h1>
            <p className="subtle">Serial {item.serialNumber}{item.homeUnit ? ` · ${item.homeUnit}` : ""}</p>
          </div>
          <span className="spacer" />
          <StatusBadge status={item.status} />
        </div>

        {auditLightState === "overdue" && (
          <div role="alert" className="alert-warning">
            This item is overdue for its annual audit.
          </div>
        )}

        {/* Gated on ACTIVE as well as auth: the builder filters retired items out
            on load (receipts/new/page.tsx:17), so offering the button for one
            would hand the operator a dead end. `?items=` is the builder's
            existing contract — no new plumbing. */}
        {loggedIn && item.status === "ACTIVE" && (
          <div className="row">
            <Link className="btn btn-primary" href={`/receipts/new?items=${item.id}`}>
              Create hand receipt
            </Link>
          </div>
        )}

        {loggedIn && (
          <ItemDetailsCard
            item={{
              id: item.id,
              deviceName: item.deviceName,
              // Non-null means the import refused MDM's autogenerated name and
              // kept this one. Shown to any signed-in user, like the rest of the
              // card's device facts — it names a device, not a person.
              mdmProposedName: item.mdmProposedName,
              homeUnit: item.homeUnit,
              deviceUIC: item.deviceUIC,
              deviceCategory: item.deviceCategory,
              storageLocation: item.storageLocation,
              currentUserEmail: item.currentUserEmail,
              currentPosition: item.currentPosition,
              // ItemDetailsCard is a client component, so its props are
              // serialized into the RSC Flight payload and reach the
              // browser regardless of what the card renders. Gate the
              // value here, server-side — do NOT "simplify" this back to
              // item.notes, or a non-admin can read admin-only notes out
              // of the response even though the UI hides them.
              notes: isAdmin ? item.notes : null,
              lastLogonUserPrincipalName: item.lastLogonUserPrincipalName,
              lastLogonDate: item.lastLogonDate,
              enrollmentDate: item.enrollmentDate,
              compliance: item.compliance,
              lastSyncDateTime: item.lastSyncDateTime,
            }}
            isAdmin={isAdmin}
            units={isAdmin ? units : []}
            categories={categories}
            suggestions={suggestions}
            dateLogged={formatDateTimeHST(item.createdAt)}
            loggedBy={item.createdBy ? formatParty({ isDcsim: false, name: item.createdBy.name, rank: item.createdBy.rank, unit: null }) : "—"}
            handReceiptHolder={
              currentHolder
                ? formatParty({ isDcsim: currentHolder.receiverIsDcsim, name: currentHolder.receiverName, rank: currentHolder.receiverRank, unit: currentHolder.receiverUnit })
                : "Not yet transferred"
            }
            lastEdited={lastEdit ? `${lastEdit.editedByName} · ${formatDateTimeHST(lastEdit.createdAt)}` : null}
          />
        )}

        {/* Readiness is DERIVED — the value above is computed, never stored, and
            the admin controls below write the UNDERLYING SIGNALS rather than a
            readiness column. MarkReadyButton stamps markedReadyAt ("it's back on
            my shelf"), which reads as Ready to deploy until something contradicts
            it: an open receipt, a service flag, or an MDM logon dated after the
            stamp. ReadinessControls exposes the same stamp plus clearing it and
            the lifecycle status; Deployed and In repair are deliberately absent
            because nothing here can set them. Logged-in only, like the Service
            and Audit cards.

            The ReadinessControls guard omits `status === "ACTIVE"` on purpose:
            un-retiring an item, and clearing a stale markedReadyAt left on one,
            both have to stay reachable ON a retired item. */}
        {loggedIn && (
          <div className="card stack-sm">
            <div className="card__title">Readiness</div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <strong>{READINESS_LABEL[readiness]}</strong>
            </div>
            {isAdmin && item.status === "ACTIVE" && <MarkReadyButton itemIds={[item.id]} />}
            {isAdmin && (
              <ReadinessControls itemIds={[item.id]} categories={categories.map((name) => ({ name }))} />
            )}
          </div>
        )}

        {loggedIn && (
          <div className="card">
            <div className="card__title">Service</div>
            {service && service.status === "PENDING" ? (
              <dl className="dl">
                <dt>Status</dt>
                <dd>Needs service</dd>
                <dt>Service type</dt>
                <dd>{serviceTypeLabel(service.serviceType, service.serviceNote)}</dd>
                <dt>Due</dt>
                <dd><DueBadge dueAt={service.dueAt ? service.dueAt.toISOString() : null} /></dd>
                <dt>Hand receipt</dt>
                <dd>
                  {service.transfer
                    ? <Link prefetch={false} href={`/receipts/${service.transfer.receiptNumber}`}><strong>{service.transfer.receiptNumber}</strong></Link>
                    : "—"}
                </dd>
              </dl>
            ) : service && service.status === "COMPLETED" ? (
              <p className="subtle">Service completed. {serviceTypeLabel(service.serviceType, service.serviceNote)}.</p>
            ) : (
              <p className="subtle">This item is not flagged for service.</p>
            )}
            {isAdmin && (
              <ServiceControls
                itemId={item.id}
                request={
                  service
                    ? {
                        id: service.id,
                        serviceType: service.serviceType,
                        serviceNote: service.serviceNote,
                        status: service.status,
                        // Formatted here, not in the client component: the
                        // deadline control only ever DISPLAYS the stored
                        // instant (the input it offers is days-from-now), so
                        // the client never needs the raw date and cannot
                        // disagree with the server about how to render it.
                        dueAtLabel: service.dueAt ? formatDateTimeHST(service.dueAt) : null,
                      }
                    : null
                }
              />
            )}
          </div>
        )}

        {loggedIn && (
          <div className="card">
            <div className="card__title">Audit</div>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <AuditLight state={auditLightState} />
              <span>
                {item.status === "RETIRED"
                  ? "Not applicable (retired)"
                  : audits.length === 0
                  ? "Never audited"
                  : `${auditStateDisplay(auditState(audits[0].createdAt, now)).label} · last audited ${formatDateTimeHST(audits[0].createdAt)} by ${audits[0].signerName}`}
              </span>
            </div>

            {isAdmin && item.status === "ACTIVE" && <AuditControls itemId={item.id} signatures={signatures} />}

            {audits.length > 0 && (
              <div className="stack-sm">
                <div className="subtle" style={{ fontSize: 12 }}>Audit history</div>
                <ul className="stack-sm">
                  {audits.map((a) => (
                    <li key={a.id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                      <span>{a.signerName} · {formatDateTimeHST(a.createdAt)}</span>
                      {/* Signature reveal sits on the RIGHT of the name/date and is
                          right-justified in the column (spacer = margin-left:auto).
                          Blob is hidden by default and fetched on demand. */}
                      <span className="spacer" />
                      <AuditSignatureReveal auditId={a.id} signerName={a.signerName} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* ADMIN-ONLY. The QR block is a property-book tool — it exists to
            print and stick a label on hardware — so it is noise for everyone
            who reaches this page by scanning that label or looking a serial up.
            Admins keep it here; the bulk QR sheet at /admin/items/qr-sheet is
            unaffected. */}
        {isAdmin && qr && (
          <div className="card stack-sm" style={{ textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${item.make} ${item.model}`} width={220} height={220} style={{ margin: "0 auto" }} />
            <p className="subtle">Scan to view this item</p>
            <p className="qr-url">{itemUrl(item.id)}</p>
            {/* Opens a printable QR-label PDF (same format as the items-list QR
                sheet). A PDF — not window.print() — because iOS/WKWebView silently
                ignores window.print(); a PDF opens in the native viewer for
                Share -> Print / Save on mobile, and prints on desktop. */}
            <a className="btn btn-primary no-print" href={`/i/${item.id}/qr/pdf`} target="_blank" rel="noopener">
              Print QR
            </a>
          </div>
        )}

        <div className="card">
          <div className="card__title">Hand receipts</div>
          {receipts.length === 0 ? (
            <p className="subtle">No hand receipts recorded for this item yet.</p>
          ) : (
            <ul className="stack-sm">
              {receipts.map((t) => (
                <li key={t.id} className="row">
                  <div>
                    {/* `prefetch={false}`: this list is unbounded — an old item
                        carries dozens of receipts — and every prefetch is a real
                        request to `/receipts/*`, which is inside the anonymous
                        300/min anti-scraping budget (docs/SECURITY.md §12). A
                        logged-out soldier opening one busy item page would spend
                        the whole unit's shared budget on links nobody clicked.
                        These are historical records, not a hot path. */}
                    <div><Link prefetch={false} href={`/receipts/${t.receiptNumber}`}><strong>{t.receiptNumber}</strong></Link></div>
                    <div className="subtle">
                      {formatParty({ isDcsim: t.senderIsDcsim, name: t.senderName, rank: t.senderRank, unit: t.senderUnit })}
                      {" → "}
                      {formatParty({ isDcsim: t.receiverIsDcsim, name: t.receiverName, rank: t.receiverRank, unit: t.receiverUnit })}
                      {" · "}{formatDateTimeHST(t.createdAt)}
                    </div>
                  </div>
                  <span className="spacer" />
                  <a className="btn btn-secondary btn-sm" href={`/receipts/${t.receiptNumber}/pdf`}>Download PDF</a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
