type Props = {
  item: {
    make: string; model: string; serialNumber: string;
    assetTag: string | null; homeLocation: string | null; notes: string | null;
    status: string; currentHolder: { name: string } | null;
  };
};
export function ItemDetails({ item }: Props) {
  const rows: [string, string][] = [
    ["Make", item.make], ["Model", item.model], ["Serial number", item.serialNumber],
    ["Asset tag", item.assetTag ?? "—"], ["Home location", item.homeLocation ?? "—"],
    ["Status", item.status], ["Current holder", item.currentHolder?.name ?? "Unassigned"],
  ];
  return (
    <dl>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 8 }}>
          <dt style={{ fontWeight: 600, minWidth: 140 }}>{k}</dt><dd>{v}</dd>
        </div>
      ))}
      {item.notes && <p><em>{item.notes}</em></p>}
    </dl>
  );
}
