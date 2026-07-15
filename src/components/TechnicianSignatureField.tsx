"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

export type PickableSignature = { id: string; name: string; image: string };

// Sentinel for the "draw a new one" option — distinct from the unselected
// placeholder (which is value=""), so the two are never confused. Real
// signature ids never collide with this.
const DRAW_NEW = "__draw__";

// Technician signing control. The admin picks WHICH technician signed from their
// saved named signatures, or draws an ad-hoc one (attributed to their own
// account name server-side).
//
// A saved pick posts only `signatureId` — never the name or the image. The
// server re-reads both from the DB scoped to the acting admin, so a client
// cannot forge a signer name, inject an image, or use another admin's
// signature. The image here is preview-only.
//
// Nothing is preselected: the admin must actively pick who signed (or choose
// to draw one) before either hidden input renders, so the form cannot be
// submitted attributed to whoever happens to sort first alphabetically.
export function TechnicianSignatureField({
  name, signatures, onChange,
}: { name: string; signatures: PickableSignature[]; onChange?: (value: string) => void }) {
  const [selectedId, setSelectedId] = useState("");
  const [drawn, setDrawn] = useState("");
  const picked = signatures.find((s) => s.id === selectedId);
  // No saved signatures at all: keep the original behavior of showing the pad
  // immediately. Otherwise only draw once the admin explicitly chose to.
  const drawing = signatures.length === 0 || selectedId === DRAW_NEW;
  // Reported upward only so the parent can gate submit; not what gets posted.
  const value = picked ? picked.image : drawing ? drawn : "";

  useEffect(() => { onChange?.(value); }, [value, onChange]);

  return (
    <div className="stack-sm">
      {signatures.length > 0 && (
        <label className="stack" style={{ gap: 4 }}>
          <span className="subtle" style={{ fontSize: 12 }}>Who signed?</span>
          <select
            className="select"
            style={{ width: "auto", minWidth: 180 }}
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
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
          <p className="subtle">This will be recorded under your own name.</p>
          <input type="hidden" name={name} value={drawn} />
        </>
      )}
    </div>
  );
}
