"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QrScanner, SCAN_FORMATS } from "@/components/QrScanner";
import { parseScans, describeScan } from "@/modules/items/scan-code";
import { resolveScannedSerial } from "@/app/actions/scan";
import { beep } from "@/lib/beep";

// Scan a code to jump to its item. Deliberately thinner than the builder's scan
// flow: this surface navigates away, so there is no list to keep in sync, no
// duplicate check and no dedupe window — the first decode that resolves ends
// the sheet's life.
export function ItemsScanButton() {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Latches on the decode that wins. The decode loop keeps firing while the
  // route transition is in flight, so without this a second frame starts
  // another lookup for a page that is already leaving. Released again on a
  // RECOVERABLE failure, so the operator can retry the same label.
  const done = useRef(false);

  const say = (kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    beep(kind);
  };

  const onDecode = async (texts: string[]) => {
    if (done.current) return;

    const intent = parseScans(texts);
    // Rejected client-side, so a stray barcode never costs a round trip. The
    // notice names what was read: an unrecognised label is otherwise a dead
    // end the operator cannot report.
    if (!intent) return say("err", `Not an item code — read ${describeScan(texts)}`);

    if (intent.kind === "item") {
      done.current = true;
      router.push(`/i/${intent.id}`);
      return;
    }

    done.current = true;
    const res = await resolveScannedSerial(intent.serial, intent.altSerial);
    if (res.ok) {
      router.push(`/i/${res.itemId}`);
      return;
    }
    if (res.code === "NOT_FOUND") {
      // Not a dead end: /items' own empty state offers an admin
      // "+ Create <serial> as a new item", linking to the new-item form with
      // the serial prefilled. Reusing it keeps ONE create path and one admin
      // gate. URLSearchParams does the encoding — a serial carrying a character
      // that means something in a query string would otherwise land the
      // operator on the wrong list.
      router.push(`/items?${new URLSearchParams({ q: intent.serial })}`);
      return;
    }

    done.current = false;
    say("err", res.code === "UNAUTHORIZED" ? "Your session expired — sign in again" : "Couldn't look up that code — try again");
  };

  if (!scanning) {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => { done.current = false; setNotice(null); setScanning(true); }}
      >
        Scan
      </button>
    );
  }

  return (
    <QrScanner
      formats={SCAN_FORMATS}
      onDecode={onDecode}
      onClose={() => setScanning(false)}
      notice={notice}
    />
  );
}
