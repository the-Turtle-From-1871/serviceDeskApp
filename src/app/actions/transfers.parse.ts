const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const bool = (fd: FormData, k: string) => {
  const v = s(fd, k);
  return v === "on" || v === "true";
};

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

export function parseTransferForm(fd: FormData) {
  return {
    itemId: s(fd, "itemId"),
    sender: party(fd, "sender"),
    receiver: party(fd, "receiver"),
    receiverSignature: String(fd.get("receiverSignature") ?? ""),
  };
}
