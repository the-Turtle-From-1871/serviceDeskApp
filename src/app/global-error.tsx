"use client"; // Error boundaries must be Client Components.

// Catches errors thrown in the ROOT layout (which app/error.tsx cannot). It
// replaces the whole document, so it must render its own <html>/<body> and can't
// rely on the app's global stylesheet — styles are inline and minimal on purpose.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, -apple-system, sans-serif", margin: 0 }}>
        <main style={{ maxWidth: 520, margin: "48px auto", padding: 24 }}>
          <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#555" }}>A critical error occurred. Please try again.</p>
          {error.digest && (
            <p style={{ fontSize: 12, color: "#888" }}>Reference: {error.digest}</p>
          )}
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{ marginTop: 12, padding: "8px 16px", cursor: "pointer" }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
