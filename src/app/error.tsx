"use client"; // Error boundaries must be Client Components.

import { useEffect } from "react";

// Root error boundary: catches unexpected runtime errors thrown by any Server
// Component / Server Action render below the root layout, so a failure shows a
// styled recovery page instead of Next's bare error screen. `unstable_retry`
// (Next 16.2+) re-fetches and re-renders the segment — the right recovery for a
// transient DB blip. The detailed error is logged server-side by Next; `digest`
// is the reference that matches those logs.
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <main className="container container-mid stack" style={{ paddingBlock: 48 }}>
      <div className="card stack-sm" role="alert">
        <h1 className="page-title" style={{ fontSize: 22 }}>Something went wrong</h1>
        <p className="subtle">
          An unexpected error occurred. You can try again, or head back to search.
        </p>
        {error.digest && (
          <p className="subtle" style={{ fontSize: 12 }}>Reference: {error.digest}</p>
        )}
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => unstable_retry()}>
            Try again
          </button>
          <a className="btn btn-ghost" href="/">Back to search</a>
        </div>
      </div>
    </main>
  );
}
