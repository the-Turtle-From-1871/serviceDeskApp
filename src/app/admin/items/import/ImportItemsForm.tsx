"use client";
import { useState } from "react";
import Link from "next/link";
import { analyzeImportAction, commitImportAction } from "@/app/admin/actions/items";

const TEMPLATE = "make,model,serialNumber,deviceName,homeUnit,notes\n";

type Skipped = { row: number; serialNumber: string; reason: string };
type Unresolved = { row: number; deviceName: string; segments: string[] };
type Analysis = {
  counts: { toImport: number; skipped: number; autoDetected: number };
  skipped: Skipped[];
  unresolved: Unresolved[];
};

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
  const [phase, setPhase] = useState<"idle" | "busy" | "resolve" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<{ added: number; skipped: Skipped[]; detected: number } | null>(null);

  // learned[UPPERCASE_ABBREV] = fullName, collected during the resolve step
  const [learned, setLearned] = useState<Record<string, string>>({});

  const isResolvedBy = (u: Unresolved) => u.segments.find((s) => learned[s.toUpperCase()]);

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
    setLearned({});
    setPhase("resolve");
  }

  async function onCommit() {
    if (!file) return;
    setError(null);
    setPhase("busy");
    const fd = new FormData();
    fd.set("file", file);
    fd.set("resolutions", JSON.stringify(Object.entries(learned).map(([abbreviation, fullName]) => ({ abbreviation, fullName }))));
    const res = await commitImportAction(fd);
    if ("error" in res) {
      setError(res.error);
      setPhase("resolve");
      return;
    }
    setResult(res);
    setPhase("done");
  }

  function reset() {
    setFile(null);
    setAnalysis(null);
    setResult(null);
    setLearned({});
    setError(null);
    setPhase("idle");
  }

  if (phase === "done" && result) {
    return (
      <div className="stack">
        <div className="card stack-sm">
          <p className="alert-success">{result.added} item{result.added === 1 ? "" : "s"} added.</p>
          {result.detected > 0 && <p className="subtle">{result.detected} home unit{result.detected === 1 ? "" : "s"} auto-detected from device names.</p>}
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

  if ((phase === "resolve" || phase === "busy") && analysis) {
    const pending = analysis.unresolved.filter((u) => !isResolvedBy(u));
    return (
      <div className="stack">
        <div className="card stack-sm">
          <p><strong>{analysis.counts.toImport}</strong> items ready to import — <strong>{analysis.counts.autoDetected}</strong> home units auto-detected, <strong>{analysis.counts.skipped}</strong> skipped.</p>
          {analysis.unresolved.length > 0 && (
            <p className="subtle">{pending.length} of {analysis.unresolved.length} device name{analysis.unresolved.length === 1 ? "" : "s"} still need a unit. Pick the segment that is the unit code and name it, or leave it — unresolved items import with an empty home unit.</p>
          )}
        </div>

        {pending.length > 0 && (
          <div className="card stack-sm" style={{ maxHeight: 360, overflowY: "auto" }}>
            {pending.map((u) => (
              <ResolveRow
                key={u.row}
                unresolved={u}
                onSave={(abbrev, fullName) => setLearned((m) => ({ ...m, [abbrev.toUpperCase()]: fullName }))}
              />
            ))}
          </div>
        )}

        {error && <p role="alert" className="alert-error">{error}</p>}
        <div className="row">
          <button className="btn btn-primary" onClick={onCommit} disabled={phase === "busy"}>
            {phase === "busy" ? "Importing…" : `Import ${analysis.counts.toImport} items`}
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
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <p className="subtle">Columns: make, model, serialNumber, deviceName, homeUnit, notes. First row must be the header. homeUnit is optional — if blank, it&apos;s auto-detected from the device name.</p>
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

function ResolveRow({ unresolved, onSave }: { unresolved: Unresolved; onSave: (abbrev: string, fullName: string) => void }) {
  const [segment, setSegment] = useState<string>(unresolved.segments[0] ?? "");
  const [fullName, setFullName] = useState("");
  return (
    <div className="field" style={{ borderBottom: "1px solid var(--border, #ccc)", paddingBottom: 8 }}>
      <p className="label" style={{ fontFamily: "monospace" }}>{unresolved.deviceName}</p>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {unresolved.segments.map((s, i) => (
          <label key={i} className="subtle" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input type="radio" name={`seg-${unresolved.row}`} checked={segment === s} onChange={() => setSegment(s)} />
            {s}
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <input className="input" placeholder="Full unit name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!segment || !fullName.trim()}
          onClick={() => onSave(segment, fullName.trim())}
        >
          Save unit
        </button>
      </div>
    </div>
  );
}
