"use client";
import { useRef, useEffect, useState } from "react";

// `name` (optional) renders a hidden input carrying the PNG data URL (existing
// usage). `onChange` (optional) reports the data URL to a parent on each
// stroke-end and on clear, so a composite field can gate submission on it.
export function SignaturePad({ name, onChange }: { name?: string; onChange?: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState("");
  const drawing = useRef(false);
  // Keep the latest onChange in a ref (updated in an effect, not during render)
  // so the pointer-event listeners below subscribe ONCE and never re-bind — the
  // component stays correct even if a caller passes an unstable onChange.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.strokeStyle = "#111";
    const emit = (u: string) => { setDataUrl(u); onChangeRef.current?.(u); };
    const pos = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
    };
    const down = (e: PointerEvent) => { drawing.current = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    const move = (e: PointerEvent) => { if (!drawing.current) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
    const up = () => { if (drawing.current) { drawing.current = false; emit(c.toDataURL("image/png")); } };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { c.removeEventListener("pointerdown", down); c.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setDataUrl("");
    onChangeRef.current?.("");
  };

  return (
    <div className="stack-sm">
      <canvas ref={canvasRef} width={360} height={140} className="sigpad" />
      <div>
        <button type="button" onClick={clear} className="btn btn-secondary btn-sm">Clear</button>
      </div>
      {name && <input type="hidden" name={name} value={dataUrl} />}
    </div>
  );
}
