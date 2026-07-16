// Audio feedback for scanning. The operator's eyes are on the hardware, not the
// screen, so accept and reject must be tellable apart by ear alone — hence two
// pitches rather than one.
//
// Audio ONLY: navigator.vibrate has never been supported in Safari on iOS, and
// iPhones are the target hardware. Do not add haptics here expecting them to
// fire.
let ctx: AudioContext | null = null;

export function beep(kind: "ok" | "err"): void {
  try {
    // Constructed lazily: an AudioContext created before a user gesture starts
    // suspended. The tap that opens the scanner is that gesture.
    ctx ??= new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = kind === "ok" ? 880 : 220;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    // Feedback is a nicety; never let it break a scan.
  }
}
