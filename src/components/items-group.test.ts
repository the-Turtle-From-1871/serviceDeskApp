import { describe, it, expect } from "vitest";
import { groupByReadiness, deployableKey, type ItemRow } from "./items-view";

const row = (id: string, deployableStatus: string | null): ItemRow => ({
  id,
  deviceName: null,
  make: "Acme",
  model: "Widget",
  serialNumber: `SN-${id}`,
  status: "ACTIVE",
  auditState: null,
  deviceUIC: null,
  deviceCategory: null,
  deployableStatus,
  isAccountedFor: true,
});

describe("deployableKey", () => {
  it("passes through the four real states", () => {
    expect(deployableKey("DEPLOYED")).toBe("DEPLOYED");
    expect(deployableKey("RETIRED")).toBe("RETIRED");
  });

  it("maps null (never triaged) to UNTRIAGED", () => {
    expect(deployableKey(null)).toBe("UNTRIAGED");
    expect(deployableKey(undefined)).toBe("UNTRIAGED");
  });

  it("maps an unrecognised value to UNTRIAGED rather than trusting it", () => {
    // Guards against a future enum value reaching an older client.
    expect(deployableKey("SOMETHING_NEW")).toBe("UNTRIAGED");
  });
});

describe("groupByReadiness", () => {
  it("returns nothing for an empty page", () => {
    expect(groupByReadiness([])).toEqual([]);
  });

  it("collects a consecutive run into one group", () => {
    const groups = groupByReadiness([row("1", "DEPLOYED"), row("2", "DEPLOYED")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("DEPLOYED");
    expect(groups[0].rows.map((r) => r.id)).toEqual(["1", "2"]);
  });

  it("starts a new group when the status changes", () => {
    const groups = groupByReadiness([
      row("1", "DEPLOYED"),
      row("2", "READY_TO_DEPLOY"),
      row("3", "READY_TO_DEPLOY"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["DEPLOYED", "READY_TO_DEPLOY"]);
    expect(groups[1].rows).toHaveLength(2);
  });

  it("groups null statuses under UNTRIAGED", () => {
    const groups = groupByReadiness([row("1", null), row("2", null)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("UNTRIAGED");
  });

  it("does NOT merge non-adjacent runs of the same status", () => {
    // The server orders rows; this function only segments what it is given.
    // Merging here would silently reorder the page and misreport counts.
    const groups = groupByReadiness([
      row("1", "DEPLOYED"),
      row("2", "IN_REPAIR"),
      row("3", "DEPLOYED"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["DEPLOYED", "IN_REPAIR", "DEPLOYED"]);
  });

  it("preserves every row exactly once", () => {
    const rows = [row("1", "DEPLOYED"), row("2", null), row("3", "IN_REPAIR"), row("4", null)];
    const flat = groupByReadiness(rows).flatMap((g) => g.rows.map((r) => r.id));
    expect(flat).toEqual(["1", "2", "3", "4"]);
  });
});
