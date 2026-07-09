"use client";
import { useEffect, useState } from "react";
import { SignaturePad } from "@/components/SignaturePad";

// Reusable technician signing control. If the tech has a saved signature it is
// pre-selected ("use saved"); otherwise they draw, with an optional "save to my
// profile" checkbox. Owns the hidden input `name` (the effective PNG data URL)
// and reports the current value via `onChange` so a parent form can gate submit.
export function TechnicianSignatureField({
  name, saveOptName, savedSignature, onChange,
}: { name: string; saveOptName?: string; savedSignature?: string | null; onChange?: (value: string) => void }) {
  const [mode, setMode] = useState<"saved" | "draw">(savedSignature ? "saved" : "draw");
  const [drawn, setDrawn] = useState("");
  const value = mode === "saved" && savedSignature ? savedSignature : drawn;

  useEffect(() => { onChange?.(value); }, [value, onChange]);

  return (
    <div className="stack-sm">
      {savedSignature && (
        <div className="row">
          <label className="row"><input type="radio" checked={mode === "saved"} onChange={() => setMode("saved")} /> Use my saved signature</label>
          <label className="row"><input type="radio" checked={mode === "draw"} onChange={() => setMode("draw")} /> Draw a new one</label>
        </div>
      )}
      {mode === "saved" && savedSignature ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={savedSignature} alt="Saved signature" className="sig-preview" />
      ) : (
        <>
          <SignaturePad onChange={setDrawn} />
          {saveOptName && !savedSignature && (
            <label className="row"><input type="checkbox" name={saveOptName} /> Save this signature to my profile for next time</label>
          )}
        </>
      )}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
