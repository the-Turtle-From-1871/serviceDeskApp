// Streaming fallback shown while a route's Server Components fetch data (e.g. the
// admin audit log's several queries). Kept static and instant — it must not fetch.
export default function Loading() {
  return (
    <main className="container container-mid stack" style={{ paddingBlock: 64, textAlign: "center" }}>
      <p className="subtle" role="status" aria-live="polite">Loading…</p>
    </main>
  );
}
