"use client";
import { useState } from "react";
import Link from "next/link";
import { analyzeImportAction, commitImportAction } from "@/app/admin/actions/items";

// Header row for the downloadable starter file. Uses the canonical spelling of
// each column; the parser also accepts the fleet export's own names (e.g.
// DeviceOwnershipUIC for deviceUIC) — see HEADER_MAP in modules/items/csv.ts.
// A second row of examples is included because `deviceType` is new and a blank
// template gives no hint of what belongs in it. The same now goes double for
// `lastSync`: production carries that header on zero rows, so this row is the
// only place the expected date format is written down for whoever builds the
// export. template.test.ts round-trips both through the real parser.
export const TEMPLATE =
  "make,model,serialNumber,deviceName,deviceType,homeUnit,deviceUIC,storageLocation,notes,assignedUser,lastLogonUserPrincipalName,lastLogonDate,enrollmentDate,compliance,lastSync\n" +
  "Dell Inc.,Latitude 5540,ABC1234,NGHINB-EXAMPLE-01,Laptop,A CO 1-234 IN,W6BTAA,Bldg 400 Cage 3,,soldier@army.mil,soldier@army.mil,7/25/2026 1:40:21 AM,5/1/2025 2:23:41 AM,compliant,8/9/2026 6:02:11 AM\n";
// A CSV of items is small; anything larger is almost certainly a mistake — and the
// two-step analyze→commit flow uploads the file twice, so bound it up front.
const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB

type Skipped = { row: number; serialNumber: string; reason: string };
type Mismatch = { serialNumber: string };
type Analysis = {
  counts: { toImport: number; toUpdate: number; unchanged: number; skipped: number };
  skipped: Skipped[];
  mismatches: Mismatch[];
};
type CommitResult = { added: number; updated: number; skipped: Skipped[]; unchanged: number; mismatches: Mismatch[] };

function groupSkipped(skipped: Skipped[]) {
  const by = new Map<string, string[]>();
  for (const s of skipped) {
    const label = s.serialNumber ? s.serialNumber : `row ${s.row}`;
    by.set(s.reason, [...(by.get(s.reason) ?? []), label]);
  }
  return [...by.entries()];
}

export function ImportItemsForm() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "busy" | "confirm" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  async function onAnalyze(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setPhase("busy");
    const fd = new FormData();
    fd.set("file", file);
    const res = await analyzeImportAction(fd);
    if ("error" in res) {
      setError(res.error);
      setPhase("idle");
      return;
    }
    setAnalysis(res);
    setPhase("confirm");
  }

  async function onCommit() {
    if (!file) return;
    setError(null);
    setPhase("busy");
    const fd = new FormData();
    fd.set("file", file);
    const res = await commitImportAction(fd);
    if ("error" in res) {
      setError(res.error);
      setPhase("confirm");
      return;
    }
    setResult(res);
    setPhase("done");
  }

  function reset() {
    setFile(null);
    setAnalysis(null);
    setResult(null);
    setError(null);
    setPhase("idle");
  }

  if (phase === "done" && result) {
    return (
      <div className="stack">
        <div className="card stack-sm">
          <p className="alert-success">{result.added} item{result.added === 1 ? "" : "s"} added · {result.updated} updated.</p>
          {result.unchanged > 0 && <p className="subtle">{result.unchanged} already up to date.</p>}
          {result.mismatches.length > 0 && (
            <p className="alert-warning">CSV make/model differ from what&apos;s stored for: {result.mismatches.map((m) => m.serialNumber).join(", ")}. Make and model are never changed by import.</p>
          )}
          {result.skipped.length > 0 ? (
            <div className="stack-sm">
              <p><strong>{result.skipped.length} skipped:</strong></p>
              <ul>
                {groupSkipped(result.skipped).map(([reason, labels]) => (
                  <li key={reason}>{reason}: {labels.join(", ")}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="subtle">No rows were skipped.</p>
          )}
          <div className="row">
            <button className="btn btn-ghost" onClick={reset}>Import another file</button>
            <Link href="/items" className="btn btn-ghost">Back to items</Link>
          </div>
        </div>
      </div>
    );
  }

  if ((phase === "confirm" || phase === "busy") && analysis) {
    return (
      <div className="stack">
        <div className="card stack-sm">
          <p><strong>{analysis.counts.toImport}</strong> to add · <strong>{analysis.counts.toUpdate}</strong> to update · <strong>{analysis.counts.unchanged}</strong> unchanged · <strong>{analysis.counts.skipped}</strong> skipped.</p>
          {analysis.mismatches.length > 0 && (
            <p className="alert-warning">CSV make/model differ from what&apos;s stored for: {analysis.mismatches.map((m) => m.serialNumber).join(", ")}. Make and model are never overwritten by import.</p>
          )}
          {/* The unit-resolution step used to live here: a row per device name
              the importer could not decode a unit from, asking an admin to pick
              a segment and name it. Home units are no longer derived from
              device names (2026-08-11), so there is nothing to resolve — the
              home unit comes from the CSV column or stays blank, and
              /admin/units lists the devices that have none. */}
        </div>

        {error && <p role="alert" className="alert-error">{error}</p>}
        <div className="row">
          <button className="btn btn-primary" onClick={onCommit} disabled={phase === "busy"}>
            {phase === "busy" ? "Importing…" : `Import ${analysis.counts.toImport + analysis.counts.toUpdate} items`}
          </button>
          <button className="btn btn-ghost" onClick={reset}>Cancel</button>
        </div>
      </div>
    );
  }

  // idle / busy: upload step
  return (
    <div className="stack">
      <form onSubmit={onAnalyze} className="card stack">
        <div className="field">
          <label className="label" htmlFor="file">CSV file</label>
          <input
            id="file"
            className="input"
            type="file"
            accept=".csv"
            required
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f && f.size > MAX_CSV_BYTES) {
                setError(`That file is too large (max ${MAX_CSV_BYTES / 1024 / 1024} MB). Split it into smaller files.`);
                setFile(null);
                e.target.value = "";
                return;
              }
              setError(null);
              setFile(f);
            }}
          />
          <div className="subtle stack-sm">
            <p>
              Only <strong>serialNumber</strong> is required. Column order and capitalisation
              don&apos;t matter, and spaces or underscores in a header are ignored
              (<code>Device Type</code> and <code>deviceType</code> are the same column).
              Unrecognised columns are skipped.
            </p>
            <p>
              <strong>Columns:</strong> make, model, serialNumber, deviceName,{" "}
              <strong>deviceType</strong> (the device category — &ldquo;Laptop&rdquo;,
              &ldquo;Switch&rdquo;; also accepts <code>deviceCategory</code> or{" "}
              <code>category</code>), homeUnit, deviceUIC (also accepts{" "}
              <code>UIC</code> or <code>DeviceOwnershipUIC</code>, the fleet export&apos;s
              name for it),{" "}
              <strong>storageLocation</strong> (where the device is stored; also
              accepts <code>SLoc</code> or <code>storageLoc</code>), notes, assignedUser,
              lastLogonUserPrincipalName, lastLogonDate, enrollmentDate, compliance,{" "}
              <strong>lastSync</strong> (also accepts <code>Last Sync</code>,{" "}
              <code>lastSyncDate</code> or <code>lastSyncDateTime</code>).
            </p>
            <p>
              <strong>lastSync is not lastLogonDate.</strong> lastSync is when MDM last
              checked in with the device; lastLogonDate is when a <em>person</em> last
              signed in. A device powered on in a cage syncs nightly with nobody using it
              for months, so the two routinely disagree — and the dashboard&apos;s
              &ldquo;devices MDM has not seen recently&rdquo; list reads lastSync. Without
              that column in the file, that list stays empty. A generic <code>sync</code>{" "}
              column is ignored, because exports sometimes use it for a status
              (&ldquo;Succeeded&rdquo;) rather than a date.
            </p>
            <p>
              A row whose serial already exists <strong>updates</strong> that item; a new
              serial creates one. make and model are required only for new items, and are
              never overwritten on an existing one. Blank cells leave the stored value
              untouched — clearing a field needs the item&apos;s edit page.
            </p>
            <p>
              Changes to device name, category, UIC and assigned user are recorded in the
              item&apos;s history; MDM telemetry updates silently. A category the file
              introduces is added to{" "}
              <Link href="/admin/categories">the managed category list</Link> automatically.
            </p>
            <p>
              A generic <code>type</code> column is <strong>deliberately ignored</strong> —
              MDM exports use it for the operating system, which would overwrite every
              device&apos;s category. Use <code>deviceType</code>. A generic{" "}
              <code>location</code> column is ignored for the same reason —
              fleet exports use it for a geographic site, not a storage location.
            </p>
          </div>
        </div>
        {error && <p role="alert" className="alert-error">{error}</p>}
        <div className="row">
          <button disabled={phase === "busy" || !file} type="submit" className="btn btn-primary">{phase === "busy" ? "Analyzing…" : "Analyze CSV"}</button>
          <a className="btn btn-ghost" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`} download="item-import-template.csv">Download template</a>
          <Link href="/items" className="btn btn-ghost">Back to items</Link>
        </div>
      </form>
    </div>
  );
}
