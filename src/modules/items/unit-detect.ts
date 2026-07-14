// Pure helpers for deriving a home unit from a device name. No I/O — the
// caller supplies the abbreviation→fullName map (keyed UPPERCASE).

export function splitSegments(deviceName: string): string[] {
  return deviceName
    .split(/[-_]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function detectHomeUnit(
  deviceName: string,
  unitsByAbbrev: Map<string, string>,
): string | undefined {
  for (const seg of splitSegments(deviceName)) {
    const full = unitsByAbbrev.get(seg.toUpperCase());
    if (full) return full;
  }
  return undefined;
}
