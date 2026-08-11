"use client";
import { useRef, useState } from "react";
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
  const looking = useRef(false);
  // Keys already in the list, so a code still in frame is not re-added. A ref,
  // not derived from `scanned`, because onDecode fires again before React has
  // re-rendered with the previous entry.
  const seen = useRef(new Set<string>());

  const say = (kind: "ok" | "err", text: string) => { setNotice({ kind, text }); beep(kind); };

  const push = (entry: ScannedEntry) => {
    if (seen.current.has(entry.key)) return false;
    seen.current.add(entry.key);
    setScanned((prev) => [...prev, entry]);
    return true;
  };

  const onDecode = async (texts: string[]) => {
    const intent = parseScans(texts);
    if (!intent) return say("err", `Not an item code — read ${describeScan(texts)}`);
    if (looking.current) return; // a lookup is already in flight; drop this frame

    // Cheap pre-check so a code still under the camera costs no round trip.
    const preKey = intent.kind === "item" ? `id:${intent.id}` : `sn:${intent.serial.toLowerCase()}`;
    if (seen.current.has(preKey)) return;

    looking.current = true;
    try {
      const res = intent.kind === "item"
        ? await resolveScannedItemId(intent.id)
        : await resolveScannedSerial(intent.serial, intent.altSerial);

      if (res.ok) {
        const kind = res.item.status === "ACTIVE" ? "found" : "retired";
        seen.current.add(preKey);
        if (push({ key: `id:${res.item.id}`, kind, item: res.item })) {
          say(kind === "found" ? "ok" : "err",
            kind === "found"
              ? `Added ${res.item.make} ${res.item.model}`
              : `${res.item.serialNumber} is retired — not added to the selection`);
        }
        return;
      }

      if (res.code === "NOT_FOUND") {
        if (intent.kind === "item") return say("err", "That item no longer exists");
        if (push({ key: preKey, kind: "new", serial: intent.serial, label: intent.label })) {
          say("err", `${intent.serial} is not in the book`);
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
    setNotice(null);
    setPhase("scanning");
    setScanning(true);
  };

  if (!scanning) return <button type="button" className="btn btn-secondary" onClick={start}>Scan</button>;

  const foundCount = scanned.filter((e) => e.kind === "found").length;

  if (phase === "creating") {
    return (
      <ScannedCreateForm
        entries={unknowns}
        onCancel={() => setScanning(false)}
        onCreated={(items) => { addMany(items); setScanning(false); }}
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
            {scanned.map((e) => (
              <li key={e.key} className="scan-list__row">
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
              </li>
            ))}
          </ul>
        )}
        <p className="scan-list__count subtle">
          {foundCount} item{foundCount === 1 ? "" : "s"} will be selected
        </p>
      </div>
    </QrScanner>
  );
}
