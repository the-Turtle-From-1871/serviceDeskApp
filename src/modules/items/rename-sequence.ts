// Pure name-sequence logic for the bulk rename. No DOM, no network, no Prisma,
// so it unit-tests directly — the same reason readiness.ts, swipe-row.ts and
// recipient-search.ts are split into leaves.
//
// It is called from BOTH sides on purpose: the client renders the live range
// line from it, and the server rebuilds the names it actually writes from it.
// One implementation means the preview and the write cannot disagree.

/** Longest prefix accepted. `deviceName` has no length constraint in the
 *  schema, but a name too long to read on a printed label is not a name, and
 *  an unbounded prefix is an unbounded write. */
export const MAX_RENAME_PREFIX = 40;

export class RenameSequenceError extends Error {
  constructor(
    public code:
      | "PREFIX_REQUIRED"
      | "PREFIX_TOO_LONG"
      | "START_NOT_DIGITS"
      | "START_OUT_OF_RANGE"
      | "COUNT_INVALID",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "RenameSequenceError";
  }
}

/**
 * The names a bulk rename will write, in caller order.
 *
 * `start` is a STRING, not a number, and that is load-bearing: the pad width is
 * inferred from how it was typed, so "001" means three digits and "1" means one.
 * Parsing it to a number first would throw that away and there would be no way
 * to ask for leading zeros.
 *
 * The width is a MINIMUM, not a ceiling: starting at "95" with ten devices
 * yields 95…99 then 100, rather than wrapping or refusing. Refusing there would
 * be a puzzle at exactly the moment someone is trying to label a shelf.
 */
export function buildRenameSequence(count: number, prefix: string, start: string): string[] {
  const trimmed = prefix.trim();
  if (!trimmed) throw new RenameSequenceError("PREFIX_REQUIRED");
  if (trimmed.length > MAX_RENAME_PREFIX) throw new RenameSequenceError("PREFIX_TOO_LONG");
  if (!/^\d+$/.test(start)) throw new RenameSequenceError("START_NOT_DIGITS");
  if (!Number.isInteger(count) || count < 1) throw new RenameSequenceError("COUNT_INVALID");

  const first = Number(start);
  // Guards a pathological start like twenty nines, where the arithmetic below
  // would silently lose precision and emit duplicate names.
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(first + count - 1)) {
    throw new RenameSequenceError("START_OUT_OF_RANGE");
  }

  const width = start.length;
  return Array.from({ length: count }, (_, i) =>
    `${trimmed}-${String(first + i).padStart(width, "0")}`,
  );
}
