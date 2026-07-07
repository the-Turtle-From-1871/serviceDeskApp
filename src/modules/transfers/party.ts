// Single source of truth for rendering a transfer party (or any rank/name pair)
// as a label. Used by the item page, receipt page, and audit log so the format
// never diverges.
export function formatParty(p: { isDcsim: boolean; name: string; rank: string | null; unit: string | null }): string {
  if (p.isDcsim) return `DCSIM · ${p.name}`;
  const head = p.rank ? `${p.rank} ${p.name}` : p.name;
  return p.unit ? `${head} (${p.unit})` : head;
}
