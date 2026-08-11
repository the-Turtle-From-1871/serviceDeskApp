import type { SelectedItem } from "@/components/items-view";

/** One row of a scan session. Its own module, not ItemsScanButton's, because
 *  ScannedCreateForm (Task 7) needs it and ItemsScanButton renders that form
 *  — declaring it in either would be an import cycle. */
export type ScannedEntry =
  | { key: string; kind: "found" | "retired"; item: SelectedItem }
  | { key: string; kind: "new"; serial: string; label?: { make: string; model: string } };

export type NewEntry = Extract<ScannedEntry, { kind: "new" }>;
