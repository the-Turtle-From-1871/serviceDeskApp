// Line rows arrive as line[<idx>][make|model|qtyAuth|qtyIssued]; itemIds as repeated "itemId".
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const bool = (fd: FormData, k: string) => { const v = s(fd, k); return v === "on" || v === "true"; };

function party(fd: FormData, prefix: "sender" | "receiver") {
  return {
    isDcsim: bool(fd, `${prefix}IsDcsim`),
    name: s(fd, `${prefix}Name`),
    rank: s(fd, `${prefix}Rank`) || undefined,
    unit: s(fd, `${prefix}Unit`) || undefined,
    contact: s(fd, `${prefix}Contact`) || undefined,
    email: s(fd, `${prefix}Email`) || undefined,
  };
}

export function parseReceiptForm(fd: FormData) {
  const itemIds = fd.getAll("itemId").map(String).filter(Boolean);
  const lines: { make: string; model: string; qtyAuth: string; qtyIssued: string }[] = [];
  for (let i = 0; fd.has(`line[${i}][make]`); i++) {
    lines.push({
      make: s(fd, `line[${i}][make]`),
      model: s(fd, `line[${i}][model]`),
      qtyAuth: s(fd, `line[${i}][qtyAuth]`),
      qtyIssued: s(fd, `line[${i}][qtyIssued]`),
    });
  }
  return { itemIds, lines, sender: party(fd, "sender"), receiver: party(fd, "receiver"), receiverSignature: String(fd.get("receiverSignature") ?? ""), returnDays: s(fd, "returnDays") };
}
