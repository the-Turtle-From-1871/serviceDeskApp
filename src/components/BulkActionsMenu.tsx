"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { recordAuditsAction } from "@/app/admin/actions/audit";
import { flagItemsForServiceAction, completeServiceItemsAction } from "@/app/admin/actions/queue";
import { previewItemRenameAction, renameItemsAction } from "@/app/admin/actions/items";
// PURE — no DOM, no Prisma — which is the only reason a Client Component may
// import it. The server rebuilds the names it writes from the same function, so
// the two cannot disagree about the SHAPE of a name. They can still disagree
// about HOW MANY: only the server knows which selected rows are retired, and it
// numbers over the survivors. That is why the range line prefers the preview's
// numbers once they arrive and treats this builder as the instant placeholder.
import { buildRenameSequence } from "@/modules/items/rename-sequence";
import { SERVICE_TYPE_OPTIONS } from "@/modules/service-queue/service-form";
import { useDismissSwallowsTap } from "./SortFilterMenu";

type Msg = { ok: boolean; text: string } | null;

type BulkResult = { error: string } | { ok: true; updated: number; skipped: number };

type RenameCollision = { name: string; serialNumber: string };

/** The rename preview, as `previewItemRenameAction` reports it. `count` is the
 *  number of names that will actually be WRITTEN — it counts ACTIVE rows only,
 *  which is why it can be smaller than the selection and why the range line
 *  prefers it over anything derived from `itemIds.length`. */
type RenamePreview = {
  count: number;
  first: string;
  last: string;
  skipped: number;
  collisions: RenameCollision[];
};

const plural = (n: number) => (n === 1 ? "" : "s");

/** "Audited 47 items. Skipped 2 (retired or not applicable)." — the skip count
 *  is never silent: all three of these actions pass over rows they cannot act
 *  on (retired kit, or an item with no pending queue row), and an operator who
 *  scanned 49 devices must be told 2 did nothing. Reporting rather than
 *  refusing is the cross-cutting rule for bulk actions here, and it diverges
 *  from the single-item `markAuditedAction` on purpose. */
function outcome(verb: string, updated: number, skipped: number): string {
  const head = `${verb} ${updated} item${plural(updated)}.`;
  return skipped > 0 ? `${head} Skipped ${skipped} (retired or not applicable).` : head;
}

/**
 * The /items selection bar's overflow sheet: the three bulk actions that need
 * inputs of their own and cannot fit inline. The bar is sticky and overlays the
 * table, so every line of height hides another row of what you are selecting
 * from — stacked inline, these three covered a phone viewport entirely.
 *
 * THIS COMPONENT honours `canAudit`, `canQueue` and `canRename` independently —
 * each group renders only when its flag is set, and none of them means no
 * trigger at all.
 * ITS ONE CALLER CURRENTLY DOES NOT EXERCISE THAT. `/items` mounts the whole
 * bulk row behind `isAdmin` (`user.role === "ADMIN"`), and the ADMIN baseline is
 * all nine capabilities, so the only combination that ever reaches this
 * component today is all-true. A `USER` granted `MANAGE_QUEUE`
 * individually does NOT see the service actions here — see the note at the
 * mount site in ItemSelectTable. The independent gating is kept because it is
 * real, it is what a second caller or a widened wrapper would need, and it
 * costs nothing.
 *
 * Either way this is PRESENTATION, never a boundary: `recordAuditsAction` calls
 * `requireAdmin()` (= `requireCapability("ADMINISTER")`), both queue actions
 * call `requireCapability("MANAGE_QUEUE")`, and both rename actions call
 * `requireCapability("MANAGE_ITEMS")`, re-read from the DB per request. The
 * batch is client-supplied ids, so that server guard is the whole of it — the
 * `isAdmin` wrapper above is a VISIBILITY gap, not a security one, and nothing
 * is over-exposed by it.
 *
 * Only ids are posted. For the audit, the signer's name and image are re-read
 * server-side scoped to the acting admin — the browser is handed signature
 * NAMES only (`listSignatureNames`) and never any ink. For the rename, only a
 * prefix and a start number are posted: the server rebuilds the name list
 * itself, so this control can never be turned into "write any string to any
 * item".
 *
 * POPOVER RULES — all inherited from SortFilterMenu and all load-bearing:
 *  - The element carrying `popover` has NO className. An author `display` beats
 *    the UA's `[popover]:not(:popover-open) { display: none }`, and every closed
 *    sheet would then render and swallow the taps meant for the bar beneath it.
 *    That has shipped twice here (the delete <dialog>, then this).
 *  - `useDismissSwallowsTap` spends the dismissing tap in the CAPTURE phase;
 *    light dismiss closes on pointerdown and still delivers the click to
 *    whatever sits underneath. Imported, never re-implemented.
 *  - Styled BY ID (#items-bulkactions), listed in all four globals.css rule
 *    groups. There is deliberately no shared class to inherit from — and note
 *    this is the SECOND popover menu on /items, so the anchored block also
 *    takes the trigger out of the shared `--sortfilter-trigger` anchor name.
 */
export function BulkActionsMenu({
  itemIds,
  signatures,
  canAudit,
  canQueue,
  canRename,
}: {
  itemIds: string[];
  /** Names only — `listSignatureNames`. No image blob reaches the browser. */
  signatures: { id: string; name: string }[];
  canAudit: boolean;
  canQueue: boolean;
  /** MANAGE_ITEMS — the bulk rename. */
  canRename: boolean;
}) {
  const menuId = "items-bulkactions";
  const triggerId = "items-bulkactions-trigger";
  useDismissSwallowsTap(menuId, triggerId);
  const router = useRouter();

  const [signatureId, setSignatureId] = useState("");
  const [serviceType, setServiceType] = useState("");
  const [note, setNote] = useState("");
  const [auditMsg, setAuditMsg] = useState<Msg>(null);
  // ONE message for both queue actions, knowingly: Flag and Complete are two
  // ends of the same job and are not used together, so a second line of height
  // in a bar that already covers a phone viewport buys nothing. The known cost
  // is that firing the second while the first is still in flight overwrites its
  // outcome — the transitions are separate, so the writes themselves never
  // interfere, only the report of the earlier one.
  const [queueMsg, setQueueMsg] = useState<Msg>(null);
  // THREE transitions, not one. These are independent operations sharing a
  // panel, and with a single `pending` flag a slow bulk write points the busy
  // state at the wrong control and disables the other two. Same reasoning as
  // ReadinessControls.
  const [auditPending, startAudit] = useTransition();
  const [flagPending, startFlag] = useTransition();
  const [completePending, startComplete] = useTransition();

  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState("001");
  const [renameMsg, setRenameMsg] = useState<Msg>(null);
  // A FOURTH transition, for the same reason as the other three.
  const [renamePending, startRename] = useTransition();

  const none = itemIds.length === 0;
  const ids = itemIds.join(",");

  // The range line, computed on the CLIENT from the same pure builder the server
  // writes from — instant, and no round trip per keystroke. try/catch rather
  // than validation, because a half-typed start ("" while it is being retyped)
  // is an expected transient and not an error worth a message.
  let range: { first: string; last: string } | null = null;
  try {
    const names = buildRenameSequence(itemIds.length, prefix, start);
    range = { first: names[0], last: names[names.length - 1] };
  } catch {
    range = null;
  }
  const hasSequence = range !== null;

  // A PREVIEW IS ONLY EVER READ FOR THE SEQUENCE IT WAS COMPUTED FOR. It is
  // stored tagged with that sequence's key and derived back out by comparison,
  // rather than being cleared by a `setState([])` at the top of the effect
  // below. Two reasons: a stale reply drives the range line AND gates the Apply
  // button, so leaving one attached to a DIFFERENT sequence would both misreport
  // the names and refuse ones that are actually free — and the derived form has
  // no render in which that can be true, where a clear-in-effect leaves one. It
  // also keeps a synchronous setState out of an effect body, which the React
  // Compiler lint refuses.
  const renameKey = `${ids}|${prefix}|${start}`;
  const [found, setFound] = useState<{ key: string; preview: RenamePreview } | null>(null);
  const preview = found?.key === renameKey ? found.preview : null;
  // The transaction's own refusal, kept in its own tagged slot so it can never
  // overwrite the range numbers. It OUTRANKS the advisory preview for the same
  // sequence — `renameItemsAction` re-checks inside its transaction, which is
  // the answer that actually counts.
  const [refused, setRefused] = useState<{ key: string; list: RenameCollision[] } | null>(null);
  const collisions = (refused?.key === renameKey ? refused.list : null) ?? preview?.collisions ?? [];

  // The debounced collision check.
  //
  // A LATE REPLY MUST NOT LAND AT ALL — being unreadable is not enough. `found`
  // is a single slot, so a superseded reply writing its own key still EVICTS a
  // current one: type "AB" then "A", let A's reply land with a collision, then
  // AB's land with none, and the alert disappears while Apply re-enables on a
  // colliding sequence — with no further request scheduled, because the deps
  // have not changed. It fails OPEN. `seq` is the guard: only the most recently
  // dispatched request may write.
  const seq = useRef(0);
  useEffect(() => {
    if (none || !canRename || !hasSequence) return;
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("itemIds", ids);
      fd.set("prefix", prefix);
      fd.set("start", start);
      const mine = ++seq.current;
      previewItemRenameAction(fd)
        .then((res) => {
          if (mine !== seq.current) return;
          if (!("ok" in res)) return;
          const { count, first, last, skipped, collisions: list } = res;
          setFound({
            key: `${ids}|${prefix}|${start}`,
            preview: { count, first, last, skipped, collisions: list },
          });
        })
        // Swallowed on purpose. This is an ADVISORY read that fires on its own
        // while someone types, so a rejection (offline, a deploy mid-keystroke)
        // must not surface as an error they did not ask for — the client-side
        // range line still stands, and Apply reports for real. Without it every
        // settled edit is an unhandled rejection; the sibling actions are awaited
        // inside a transition, where React routes a throw to the error boundary.
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
    // `range` is derived from these and is a fresh object every render, so
    // depending on it directly would re-run this on every render — hence the
    // boolean `hasSequence` rather than the object.
  }, [prefix, start, ids, none, canRename, hasSequence]);

  // What the line actually says, and what Apply actually promises. The preview
  // when there is one, the client-side range until then, nothing if the fields
  // do not yet make a sequence.
  const line = preview
    ? { count: preview.count, first: preview.first, last: preview.last, skipped: preview.skipped }
    : range
      ? { count: itemIds.length, first: range.first, last: range.last, skipped: 0 }
      : null;
  // Kept in step with the line: a button reading "Rename 10" over a line saying
  // eight will be written is the same lie in a second place.
  const applyCount = line ? line.count : itemIds.length;

  /** Apply. The selection is deliberately KEPT afterwards, exactly as `run`
   *  keeps it — clearing unmounts the sticky bar holding this message. */
  const applyRename = () => {
    setRenameMsg(null);
    const fd = new FormData();
    fd.set("itemIds", ids);
    fd.set("prefix", prefix);
    fd.set("start", start);
    startRename(async () => {
      const res = await renameItemsAction(fd);
      if ("error" in res) return setRenameMsg({ ok: false, text: res.error });
      if ("conflict" in res) {
        // The preview is advisory; the action re-checks inside its transaction,
        // so this is the answer that actually counts. Its OWN tagged slot, so a
        // refusal can never overwrite the range numbers with values it does not
        // carry.
        setRefused({ key: renameKey, list: res.collisions });
        return setRenameMsg({ ok: false, text: "Those names are already taken." });
      }
      setRenameMsg({
        ok: true,
        text:
          outcome("Renamed", res.renamed, res.skipped) +
          (res.unchanged > 0 ? ` ${res.unchanged} already had the right name.` : ""),
      });
      router.refresh();
    });
  };

  /** Post one batch and report its outcome. The selection is deliberately KEPT
   *  — clearing it unmounts the sticky bar this sheet lives in, destroying the
   *  message that is the only confirmation anything happened, and a 150-device
   *  batch cost real physical effort to collect. `router.refresh()` is what
   *  repaints the badges the action just moved. */
  const run = (
    start: React.TransitionStartFunction,
    setMsg: (m: Msg) => void,
    fields: Record<string, string>,
    call: (fd: FormData) => Promise<BulkResult>,
    verb: string,
  ) => {
    setMsg(null);
    const fd = new FormData();
    fd.set("itemIds", ids);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    start(async () => {
      const res = await call(fd);
      if ("error" in res) {
        setMsg({ ok: false, text: res.error });
        return;
      }
      setMsg({ ok: true, text: outcome(verb, res.updated, res.skipped) });
      router.refresh();
    });
  };

  // Nothing this caller may do — render no trigger at all rather than a button
  // that opens onto an empty sheet. Placed after the hooks, which must not sit
  // behind a conditional return.
  if (!canAudit && !canQueue && !canRename) return null;

  return (
    <>
      <button
        type="button"
        id={triggerId}
        className="btn btn-secondary menu-trigger"
        popoverTarget={menuId}
        disabled={none}
      >
        <span className="menu-trigger__label">More actions</span>
        {/* An SVG, not a "⌄" glyph: a text chevron is placed by font metrics and
            sits high in its em box. Same reasoning as SortFilterMenu. */}
        <ChevronDown className="menu-trigger__chevron" aria-hidden="true" />
      </button>

      {/* NO className on this element. See the trap note above. */}
      <div id={menuId} popover="auto">
        <div className="popup-menu__panel stack-sm">
          {canAudit && (
            <div className="stack" style={{ gap: 6 }}>
              {/* A real <label htmlFor>, so the select's accessible name is the
                  caption and tapping the caption opens the picker. */}
              <label className="label" htmlFor="bulk-sig">Sign as</label>
              <select
                id="bulk-sig"
                className="select"
                value={signatureId}
                disabled={auditPending || none || signatures.length === 0}
                onChange={(e) => setSignatureId(e.target.value)}
              >
                <option value="">Choose…</option>
                {signatures.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={auditPending || none || !signatureId}
                onClick={() => {
                  // The one control here that writes accountability records —
                  // it asserts that a named person laid eyes on every one of
                  // these devices, and there is no undo. The confirm names the
                  // count AND the signer, because both are things a mistap gets
                  // wrong (the wrong batch rehydrated from a previous sweep, or
                  // the wrong name left in the picker).
                  const signer = signatures.find((s) => s.id === signatureId)?.name ?? "";
                  const ok = window.confirm(
                    `Record an audit for ${itemIds.length} item${plural(itemIds.length)}, signed as ${signer}?\n\n` +
                    `This writes an accountability record for each device and cannot be undone.`,
                  );
                  if (!ok) return;
                  run(startAudit, setAuditMsg, { signatureId }, recordAuditsAction, "Audited");
                }}
              >
                {auditPending ? "Recording…" : `Audit ${itemIds.length} item${plural(itemIds.length)}`}
              </button>
              {/* An empty picker with no explanation reads as a broken control;
                  the capability is held, the ink simply does not exist yet. */}
              {signatures.length === 0 && (
                <span className="subtle">No saved signatures — add one under Account.</span>
              )}
              {/* role="alert" on a failure, "status" on a success. A polite
                  live region carrying .alert-error is an error a screen-reader
                  user is never told about; the same bar already uses "alert"
                  for its receipt errors. */}
              {auditMsg && (
                <span role={auditMsg.ok ? "status" : "alert"} className={auditMsg.ok ? "subtle" : "alert-error"}>{auditMsg.text}</span>
              )}
            </div>
          )}

          {canQueue && (
            <div className="stack" style={{ gap: 6 }}>
              <label className="label" htmlFor="bulk-service">Service type</label>
              <select
                id="bulk-service"
                className="select"
                value={serviceType}
                disabled={flagPending || none}
                onChange={(e) => setServiceType(e.target.value)}
              >
                <option value="">Choose…</option>
                {SERVICE_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {/* Not `required`: a browser-side constraint on a control that is
                  not inside a <form> buys nothing, and the server already
                  refuses OTHER with no note (NOTE_REQUIRED → a real message). */}
              <input
                className="input"
                aria-label="Service note"
                placeholder={serviceType === "OTHER" ? "What needs doing? (required)" : "Note (optional)"}
                value={note}
                disabled={flagPending || none}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary"
                disabled={flagPending || none || !serviceType}
                onClick={() =>
                  run(
                    startFlag,
                    setQueueMsg,
                    { serviceType, note },
                    flagItemsForServiceAction,
                    "Flagged",
                  )
                }
              >
                {flagPending ? "Flagging…" : "Flag for service"}
              </button>

              {/* No deadline field: `overrideDays` is never posted, so a blank
                  means no deadline on create and no change on update — the
                  documented behaviour of a blank, and the batch has no per-item
                  "already flagged?" state a form could branch on. */}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={completePending || none}
                onClick={() =>
                  run(
                    startComplete,
                    setQueueMsg,
                    {},
                    completeServiceItemsAction,
                    "Completed service on",
                  )
                }
                title="Mark service finished and record these devices as back on hand"
              >
                {completePending ? "Completing…" : "Complete service"}
              </button>
              {/* See the audit message above: a failure announces as an alert. */}
              {queueMsg && (
                <span role={queueMsg.ok ? "status" : "alert"} className={queueMsg.ok ? "subtle" : "alert-error"}>{queueMsg.text}</span>
              )}
            </div>
          )}

          {canRename && (
            <div className="stack" style={{ gap: 6 }}>
              {/* "Rename — " prefixes the first label because this is the third
                  section in one panel and a bare "Name prefix" says nothing
                  about what it is the prefix OF. */}
              <label className="label" htmlFor="bulk-prefix">Rename — name prefix</label>
              <input
                id="bulk-prefix"
                className="input"
                value={prefix}
                disabled={renamePending || none}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="e.g. LAPTOP"
              />
              <label className="label" htmlFor="bulk-start">Start at</label>
              {/* TEXT, with inputMode for the phone keypad — never type="number".
                  The pad width is inferred from how the start was typed, so a
                  numeric input stripping the leading zeros would silently turn
                  "001" into "1" and the whole sequence with it. */}
              <input
                id="bulk-start"
                className="input"
                inputMode="numeric"
                value={start}
                disabled={renamePending || none}
                onChange={(e) => setStart(e.target.value)}
              />
              {/* "in scan order" is the load-bearing half: the numbers follow
                  the order the batch was selected or scanned in, which is the
                  order the devices are physically stacked.

                  THE SERVER'S NUMBERS WIN ONCE THEY LAND. `previewRename`
                  numbers over ACTIVE rows only, so ten selected devices of which
                  two are retired write 001..008 — and people print labels off
                  this line, so promising 001..010 from `itemIds.length` would be
                  a lie in exactly the case a bulk action exists for. The
                  client-side range is the instant placeholder that keeps typing
                  responsive until the debounced preview replies. */}
              {line && (
                <span className="subtle">
                  {line.count === 0
                    ? `Nothing to rename — all ${line.skipped} selected device${plural(line.skipped)} retired.`
                    : `${line.count} device${plural(line.count)}, in scan order: ${line.first} … ${line.last}`}
                  {line.count > 0 && line.skipped > 0 &&
                    ` ${line.skipped} retired device${plural(line.skipped)} skipped.`}
                </span>
              )}
              {/* Names the offenders and their serials rather than just refusing:
                  the fix is a different prefix or start, and you cannot pick one
                  without knowing what is in the way. */}
              {collisions.length > 0 && (
                <span role="alert" className="alert-error">
                  {collisions.length} name{plural(collisions.length)} already taken:{" "}
                  {collisions.map((c) => `${c.name} (${c.serialNumber})`).join(", ")}
                </span>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={renamePending || none || !range || applyCount === 0 || collisions.length > 0}
                onClick={applyRename}
              >
                {renamePending ? "Renaming…" : `Rename ${applyCount}`}
              </button>
              {collisions.length > 0 && (
                <span className="subtle">Change the prefix or start number to continue.</span>
              )}
              {/* See the audit message above: a failure announces as an alert. */}
              {renameMsg && (
                <span role={renameMsg.ok ? "status" : "alert"} className={renameMsg.ok ? "subtle" : "alert-error"}>{renameMsg.text}</span>
              )}
            </div>
          )}

          {/* Sheet-only (hidden above 720px by globals.css), and it is also what
              gives the sheet its bottom padding and safe-area inset. A thumb has
              no Escape key and no obvious outside to tap; a mouse and keyboard
              have both. `popovertargetaction` means this costs no handler and no
              state. */}
          <div className="popup-menu__footer">
            <button
              type="button"
              className="btn btn-secondary"
              popoverTarget={menuId}
              popoverTargetAction="hide"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
