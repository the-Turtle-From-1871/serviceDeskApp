"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

export type PickableSignature = { id: string; name: string; image: string };

// Sentinel for the "draw a new one" option — distinct from the unselected
// placeholder (which is value=""), so the two are never confused. Real
// signature ids never collide with this.
const DRAW_NEW = "__draw__";

const DEFAULT_DRAW_HINT = "This will be recorded under your own name.";

// Signature picking control. The user picks WHICH person signed from their saved
// named signatures, or draws an ad-hoc one.
//
// A saved pick posts only `signatureId` — never the name or the image. The
// server re-reads both from the DB scoped to the acting user, so a client
// cannot forge a signer name, inject an image, or use another user's
// signature. The image here is preview-only.
//
// Nothing is preselected: the user must actively pick who signed (or choose to
// draw one) before either hidden input renders, so the form cannot be submitted
// attributed to whoever happens to sort first alphabetically.
//
// `drawHint` is a default PARAMETER, not `?? DEFAULT_DRAW_HINT`: a caller passes
// null to render no hint at all, and `??` would resurrect the default for it.
export function TechnicianSignatureField({
  name, signatures, onChange, onPickedChange,
  label = "Who signed?",
  drawHint = DEFAULT_DRAW_HINT,
}: {
  name: string;
  signatures: PickableSignature[];
  onChange?: (value: string) => void;
  onPickedChange?: (pickedId: string | null) => void;
  label?: string;
  drawHint?: string | null;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [drawn, setDrawn] = useState("");
  const picked = signatures.find((s) => s.id === selectedId);
  // No saved signatures at all: keep the original behavior of showing the pad
  // immediately. Otherwise only draw once the user explicitly chose to.
  const drawing = signatures.length === 0 || selectedId === DRAW_NEW;
  // Reported upward only so the parent can gate submit; not what gets posted.
  const value = picked ? picked.image : drawing ? drawn : "";
  const pickedId = picked?.id ?? null;

  useEffect(() => { onChange?.(value); }, [value, onChange]);
  useEffect(() => { onPickedChange?.(pickedId); }, [pickedId, onPickedChange]);

  return (
    <div className="stack-sm">
      {signatures.length > 0 && (
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>{label}</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 180 }}
            value={selectedId}
            // Discard any drawn ink whenever the selection changes. SignaturePad
            // reports upward only on stroke-end and on Clear — never on mount —
            // so without this, leaving and re-entering "Draw a new one…" mounts a
            // visually BLANK pad while `drawn` still holds the earlier squiggle,
            // and the hidden input silently re-posts it. On this form that ships
            // one person's ink under another person's name on a DA 2062.
            onChange={(e) => { setSelectedId(e.target.value); setDrawn(""); }}
          >
            <option value="" disabled>— Select who signed —</option>
            {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value={DRAW_NEW}>Draw a new one…</option>
          </select>
        </label>
      )}

      {picked && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picked.image} alt={`Signature for ${picked.name}`} className="sig-preview" />
          <input type="hidden" name="signatureId" value={picked.id} />
        </>
      )}
      {drawing && (
        <>
          <SignaturePad onChange={setDrawn} />
          {drawHint && <p className="subtle">{drawHint}</p>}
          <input type="hidden" name={name} value={drawn} />
        </>
      )}
    </div>
  );
}
