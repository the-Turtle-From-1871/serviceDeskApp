"use client";

export function PrintQrButton() {
  return (
    <button
      type="button"
      className="btn btn-secondary no-print"
      onClick={() => window.print()}
    >
      Print QR
    </button>
  );
}
