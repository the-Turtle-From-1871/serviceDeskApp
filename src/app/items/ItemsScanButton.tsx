"use client";
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { QrScanner, SCAN_FORMATS } from "@/components/QrScanner";
import { parseScans, describeScan } from "@/modules/items/scan-code";
import { resolveScannedSerial, resolveScannedItemId } from "@/app/actions/scan";
import { useItemSelection } from "@/components/ItemSelection";
import { ScannedCreateForm } from "./ScannedCreateForm";
import type { ScannedEntry, NewEntry } from "./scan-session";
import { beep } from "@/lib/beep";

/**
 * Scan a batch of codes into the /items selection.
 *
 * Every scan APPENDS; nothing navigates. The continuous-scanning rules are the
 * ones ReceiptBuilderForm already proved: one lookup in flight at a time, and a
 * dedupe window so a code still under the camera is not read twice.
 */
export function ItemsScanButton({ canCreate }: { canCreate: boolean }) {
  const { addMany } = useItemSelection();
  const [scanning, setScanning] = useState(false);
  const [phase, setPhase] = useState<"scanning" | "creating">("scanning");
  const [scanned, setScanned] = useState<ScannedEntry[]>([]);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [result, setResult] = useState<{ created: number; existed: number } | null>(null);
  const looking = useRef(false);
  // Keys already in the list, so a code still in frame is not re-added. A ref,
  // not derived from `scanned`, because onDecode fires again before React has
  // re-rendered with the previous entry.
  const seen = useRef(new Set<string>());
  // entry.key -> the OTHER seen key recorded for it (a "found"/"retired" row
  // adds both the id-keyed entry.key AND the serial-keyed preKey the scan
  // resolved from). Removing a row has to release both, or the label that was
  // just removed from the list still reads as "already scanned".
  const linkedKey = useRef(new Map<string, string>());
  // Throttles the "Already scanned" notice — `seen` itself dedupes forever,
  // but a linear barcode re-decodes on every camera frame, and without this a
  // code still sitting under the camera would beep continuously instead of
  // once every so often. Same 1.5s window ReceiptBuilderForm uses for its own
  // repeat-decode dedupe.
  const lastNotice = useRef<{ key: string; at: number }>({ key: "", at: 0 });

  const say = (kind: "ok" | "err", text: string) => { setNotice({ kind, text }); beep(kind); };

  const noticeThrottled = (key: string) => {
    const now = Date.now();
    if (lastNotice.current.key === key && now - lastNotice.current.at < 1500) return false;
    lastNotice.current = { key, at: now };
    return true;
  };

  const push = (entry: ScannedEntry, linkedSeenKey?: string) => {
    if (seen.current.has(entry.key)) return false;
    seen.current.add(entry.key);
    if (linkedSeenKey) linkedKey.current.set(entry.key, linkedSeenKey);
    setScanned((prev) => [...prev, entry]);
    return true;
  };

  // Drops one row: from the list, and from `seen` (both keys it may have
  // registered), so the label it came from can be scanned again in this same
  // session — the fix for a neighbouring label caught by mistake.
  const remove = (key: string) => {
    setScanned((prev) => prev.filter((e) => e.key !== key));
    seen.current.delete(key);
    const linked = linkedKey.current.get(key);
    if (linked) {
      seen.current.delete(linked);
      linkedKey.current.delete(key);
    }
  };

  const onDecode = async (texts: string[]) => {
    const intent = parseScans(texts);
    if (!intent) return say("err", `Not an item code — read ${describeScan(texts)}`);
    if (looking.current) return; // a lookup is already in flight; drop this frame

    // Cheap pre-check so a code still under the camera costs no round trip.
    const preKey = intent.kind === "item" ? `id:${intent.id}` : `sn:${intent.serial.toLowerCase()}`;
    if (seen.current.has(preKey)) {
      if (noticeThrottled(preKey)) say("err", "Already scanned");
      return;
    }

    looking.current = true;
    try {
      const res = intent.kind === "item"
        ? await resolveScannedItemId(intent.id)
        : await resolveScannedSerial(intent.serial, intent.altSerial);

      if (res.ok) {
        const kind = res.item.status === "ACTIVE" ? "found" : "retired";
        seen.current.add(preKey);
        const entry: ScannedEntry = { key: `id:${res.item.id}`, kind, item: res.item };
        if (push(entry, preKey)) {
          say(kind === "found" ? "ok" : "err",
            kind === "found"
              ? `Added ${res.item.make} ${res.item.model}`
              : `${res.item.serialNumber} is retired — not added to the selection`);
        } else if (noticeThrottled(entry.key)) {
          say("err", "Already scanned");
        }
        return;
      }

      if (res.code === "NOT_FOUND") {
        if (intent.kind === "item") return say("err", "That item no longer exists");
        if (push({ key: preKey, kind: "new", serial: intent.serial, label: intent.label })) {
          say("err", `${intent.serial} is not in the book`);
        } else if (noticeThrottled(preKey)) {
          say("err", "Already scanned");
        }
        return;
      }

      say("err", res.code === "UNAUTHORIZED"
        ? "Your session expired — sign in again"
        : "Couldn't look up that code — try again");
    } finally {
      looking.current = false;
    }
  };

  const commitFound = () =>
    addMany(
      scanned
        .filter((e): e is ScannedEntry & { kind: "found" } => e.kind === "found")
        .map((e) => e.item),
    );

  const unknowns = scanned.filter((e): e is NewEntry => e.kind === "new");

  // Done commits the ACTIVE items and closes — unless there are unknown serials
  // and the operator may create them, in which case the sheet becomes the
  // create form. It ADDS to whatever is already selected rather than replacing.
  const finish = () => {
    commitFound();
    if (canCreate && unknowns.length > 0) return setPhase("creating");
    setScanning(false);
  };

  const start = () => {
    setScanned([]);
    seen.current = new Set();
    linkedKey.current = new Map();
    lastNotice.current = { key: "", at: 0 };
    setNotice(null);
    setResult(null);
    setPhase("scanning");
    setScanning(true);
  };

  if (!scanning) return <button type="button" className="btn btn-secondary" onClick={start}>Scan</button>;

  const foundCount = scanned.filter((e) => e.kind === "found").length;

  // The create batch's own outcome — how many were actually new vs. already
  // existed under the same serial (createMany's skipDuplicates can find both
  // in one batch). Shown before the sheet closes so an admin creating five
  // serials sees a confirmation rather than the sheet just vanishing, and so
  // the "already existed" case — the whole reason skipDuplicates was chosen
  // over failing the batch — is actually reported rather than swallowed.
  if (result) {
    return (
      <div className="scan-create stack-sm">
        <p role="status" className="alert-success">
          {result.created} item{result.created === 1 ? "" : "s"} created
          {result.existed > 0 ? ` · ${result.existed} already existed` : ""}.
        </p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setScanning(false)}>Done</button>
        </div>
      </div>
    );
  }

  if (phase === "creating") {
    return (
      <ScannedCreateForm
        entries={unknowns}
        onCancel={() => setScanning(false)}
        onCreated={(items, created, existed) => { addMany(items); setResult({ created, existed }); }}
      />
    );
  }

  return (
    <QrScanner
      formats={SCAN_FORMATS}
      onDecode={onDecode}
      onClose={finish}
      notice={notice}
      doneLabel={`Done · ${foundCount} item${foundCount === 1 ? "" : "s"}`}
    >
      <div className="scan-list">
        {scanned.length === 0 ? (
          <p className="scan-list__empty subtle">Scanned items appear here.</p>
        ) : (
          <ul className="scan-list__items">
            {scanned.map((e) => {
              const serial = e.kind === "new" ? e.serial : e.item.serialNumber;
              return (
                <li key={e.key} className="scan-list__row">
                  <span className="scan-list__info">
                    {e.kind === "new" ? (
                      <>
                        <strong>{e.serial}</strong>
                        <span className="scan-list__flag">Not in the book</span>
                      </>
                    ) : (
                      <>
                        <strong>{e.item.serialNumber}</strong>
                        <span className="scan-list__meta">{e.item.make} {e.item.model}</span>
                        {e.kind === "retired" && <span className="scan-list__flag">Retired</span>}
                      </>
                    )}
                  </span>
                  <button
                    type="button"
                    className="scan-list__remove"
                    aria-label={`Remove ${serial}`}
                    onClick={() => remove(e.key)}
                  >
                    <X aria-hidden="true" focusable="false" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="scan-list__count subtle">
          {foundCount} item{foundCount === 1 ? "" : "s"} will be selected
        </p>
      </div>
    </QrScanner>
  );
}
