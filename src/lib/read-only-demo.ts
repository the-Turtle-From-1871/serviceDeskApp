// Marks a DEMO account: one that may read the whole app but whose writes are
// refused (see `denyReadOnly` in src/lib/authz.ts).
//
// PURE on purpose — no Prisma, no `server-only`, no next/* import — for the same
// reason capabilities.ts and readiness.ts are: it unit-tests without a database,
// and it has to be importable from `src/app/actions/auth.ts`, which runs on the
// unauthenticated password-reset path.
//
// This is NOT part of the capability model, and must never become one.
// Capabilities are additive with no negative grant, deliberately (CLAUDE.md §1);
// expressing "reads but never writes" as a capability would reintroduce exactly
// the subtractive model that is banned there. This sits beside them and answers
// a different question — "may this session write at all".
//
// IT FAILS OPEN. An unset or misspelled READ_ONLY_DEMO_EMAILS means nobody is
// read-only, so a demo account keeps whatever its ROLE grants — which for the
// account this exists for is ADMIN. That tradeoff is recorded in
// docs/SECURITY.md under Known gaps; the banner in src/app/admin/layout.tsx is
// the visible tell that the variable is actually set, and is a control rather
// than decoration for that reason.

/** Whether this address is configured as a read-only demo account. */
export function isReadOnlyDemo(email: string | null | undefined): boolean {
  if (!email) return false;
  // Read per call rather than snapshotting at module load: the value is read on
  // a request path, and a module-load snapshot would be wrong for the whole
  // process if the variable changed, and untestable per case.
  const raw = process.env.READ_ONLY_DEMO_EMAILS;
  if (!raw) return false;
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(wanted);
}
