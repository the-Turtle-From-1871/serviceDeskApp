type Props = {
  item: {
    make: string; model: string; serialNumber: string;
    homeUnit: string | null; notes: string | null;
    status: string;
  };
};
export function ItemDetails({ item }: Props) {
  const rows: [string, string][] = [
    ["Make", item.make],
    ["Model", item.model],
    ["Serial number", item.serialNumber],
    ["Home unit", item.homeUnit ?? "—"],
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
