"use client";
import { useEffect, useRef, useState } from "react";

type Notice = { kind: "ok" | "err"; text: string } | null;
type Props = { onDecode: (text: string) => void; onClose: () => void; notice?: Notice };

type Status = "starting" | "running" | "denied" | "unavailable" | "loadfailed";

// A camera sheet that emits decoded strings. It owns the media stream and the
// decode loop and NOTHING else — no knowledge of items, receipts, or the
// schema. Keep it that way: it is what makes this testable without the builder.
//
// Rendered as an OVERLAY, never a route. Routing away from the builder would
// remount it and discard the drawn signature and every typed field.
//
// `notice` is rendered ON TOP of the sheet: the sheet is opaque and full-screen,
// so scan feedback left in the form behind it is invisible when it fires.
export function QrScanner({ onDecode, onClose, notice }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>("starting");
  // Kept in a ref so the effect below subscribes ONCE and never re-binds on an
  // unstable callback — same reasoning as SignaturePad.tsx:14-15.
  const onDecodeRef = useRef(onDecode);
  useEffect(() => { onDecodeRef.current = onDecode; }, [onDecode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("unavailable");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch {
        // On iOS a denial is permanent for the site: Safari remembers it and JS
        // cannot re-prompt, so getUserMedia just fails forever. The UI below
        // must name the way out rather than say "denied".
        setStatus("denied");
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});

      // Lazy: pulls zxing-wasm only when the sheet actually opens, keeping it
      // out of the builder's initial bundle. `/ponyfill` exports the class
      // without patching globals (`/polyfill` is the global-patching variant),
      // and re-exports prepareZXingModule from zxing-wasm.
      const { BarcodeDetector, prepareZXingModule } = await import("barcode-detector/ponyfill");
      // Serve the .wasm from OUR origin, NOT the default jsDelivr CDN. The npm
      // tarball is what package-lock.json hashes and `npm audit` covers; the CDN
      // copy is a DIFFERENT, unverified binary — and it fails silently offline.
      // The verified copy is staged into public/wasm by scripts/copy-wasm.mjs
      // (Step 4a). locateFile receives the bare filename "zxing_reader.wasm".
      prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith(".wasm") ? `/wasm/${path}` : `${prefix}${path}`,
        },
      });

      let detector: InstanceType<typeof BarcodeDetector>;
      try {
        detector = new BarcodeDetector({ formats: ["qr_code"] });
        // Force the module to load NOW, against a throwaway 1×1 canvas, so a
        // failure (offline, blocked CSP, missing wasm) surfaces as a visible
        // status instead of being swallowed frame-by-frame in tick() — which
        // would leave the camera previewing forever while nothing ever decodes.
        const probe = document.createElement("canvas");
        probe.width = probe.height = 1;
        await detector.detect(probe);
      } catch {
        setStatus("loadfailed");
        return;
      }
      if (stopped) return;
      setStatus("running");

      const tick = async () => {
        if (stopped) return;
        try {
          const hits = await detector.detect(video);
          if (hits[0]?.rawValue) onDecodeRef.current(hits[0].rawValue);
        } catch {
          // A frame that fails to decode is normal; the module already loaded.
        }
        if (!stopped) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      // Load-bearing: without this the camera indicator stays lit after the
      // sheet closes, which reads as spyware.
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="scan-sheet" role="dialog" aria-modal="true" aria-label="Scan an item">
      <div className="scan-sheet__frame">
        {/* playsInline is REQUIRED: without it iOS Safari hijacks playback into
            its fullscreen native player and this overlay breaks entirely. It is
            the single most common way in-page scanners fail on iPhone. */}
        <video ref={videoRef} className="scan-sheet__video" playsInline muted autoPlay />
        {status === "starting" && <p className="scan-sheet__msg">Starting the camera…</p>}
        {status === "denied" && (
          <p className="scan-sheet__msg" role="alert">
            Camera access is blocked. Safari remembers this per site and cannot ask again —
            turn it back on in Settings → Safari → Camera, or the <strong>aA</strong> menu →
            Website Settings. You can also pick items from the Items list instead.
          </p>
        )}
        {status === "unavailable" && (
          <p className="scan-sheet__msg" role="alert">
            This device has no camera available. Pick items from the Items list instead.
          </p>
        )}
        {status === "loadfailed" && (
          <p className="scan-sheet__msg" role="alert">
            The scanner failed to load — check your connection and try again, or pick items
            from the Items list instead.
          </p>
        )}
        {/* Scan feedback, on top of the video. */}
        {notice && (
          <p className={`scan-sheet__notice ${notice.kind === "ok" ? "alert-success" : "alert-error"}`} role="status" aria-live="polite">
            {notice.text}
          </p>
        )}
      </div>
      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
