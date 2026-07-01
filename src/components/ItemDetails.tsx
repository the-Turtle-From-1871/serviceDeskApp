type Props = {
  item: {
    make: string; model: string; serialNumber: string;
    assetTag: string | null; homeLocation: string | null; notes: string | null;
    status: string; currentHolder: { name: string } | null;
  };
};
export function ItemDetails({ item }: Props) {
  const rows: [string, string][] = [
    ["Make", item.make],
    ["Model", item.model],
    ["Serial number", item.serialNumber],
    ["Asset tag", item.assetTag ?? "—"],
    ["Home location", item.homeLocation ?? "—"],
    ["Current holder", item.currentHolder?.name ?? "Unassigned"],
  ];
  return (
    <div className="stack-sm">
      <dl className="dl">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {item.notes && <p className="hint" style={{ fontStyle: "italic" }}>{item.notes}</p>}
    </div>
  );
}
