// THE definition of what each role can do, and how a grant adds to it.
//
// Pure on purpose: `import type` is erased at compile time, so this module
// pulls in no Prisma client and can be unit-tested without a database — the
// same reason readiness.ts and recipient-search.ts are split out. Do not add a
// runtime import here.
//
// This is the ONLY place the role -> capability mapping is written. Do not
// restate it in SQL, in a component, or in a test helper: a second copy is a
// second answer to "what can this person do", and they will disagree.
import type { Capability, Role } from "@prisma/client";

/** Canonical order. Every list rendered to a user, and every array this module
 *  returns, is sorted by this — so two equal capability sets are also equal
 *  arrays, and a UI list never reshuffles between renders. */
export const CAPABILITIES = [
  "VIEW_INVENTORY",
  "VIEW_ALL_RECEIPTS",
  "CREATE_RECEIPTS",
  "EDIT_ITEM_HOLDER",
  "MANAGE_ITEMS",
  "MANAGE_QUEUE",
  "PROCESS_RETURNS",
  "VIEW_ANALYTICS",
  "ADMINISTER",
] as const satisfies readonly Capability[];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  VIEW_INVENTORY: "View inventory",
  VIEW_ALL_RECEIPTS: "View all hand receipts",
  CREATE_RECEIPTS: "Create hand receipts",
  EDIT_ITEM_HOLDER: "Edit an item's holder and position",
  MANAGE_ITEMS: "Manage items, categories and units",
  MANAGE_QUEUE: "Manage the service queue",
  PROCESS_RETURNS: "Process returns",
  VIEW_ANALYTICS: "View analytics",
  ADMINISTER: "Administer the application",
};

/** Capabilities that hand over administrative control and are shown in the
 *  danger treatment wherever they appear. Drives the red UI from one place so
 *  the request form and the approval queue cannot disagree. */
const ELEVATED: readonly Capability[] = ["ADMINISTER"];

/** Held by every account, so asking for it is meaningless. */
const UNIVERSAL: Capability = "VIEW_INVENTORY";

// USER is exactly today's rights: read the shared property book, look at any
// receipt (they are public anyway), file a receipt, and correct an item's
// holder/position. Widening or narrowing this changes what live accounts can
// do — which the capability migration must not.
const BASELINES: Record<Role, readonly Capability[]> = {
  VIEWER: [UNIVERSAL],
  USER: [UNIVERSAL, "VIEW_ALL_RECEIPTS", "CREATE_RECEIPTS", "EDIT_ITEM_HOLDER"],
  ADMIN: CAPABILITIES,
};

function inCanonicalOrder(set: ReadonlySet<Capability>): Capability[] {
  return CAPABILITIES.filter((c) => set.has(c));
}

/** The capabilities a role confers with no grants at all. */
export function roleBaseline(role: Role): Capability[] {
  return inCanonicalOrder(new Set(BASELINES[role]));
}

/** What a user can actually do: the role baseline UNION their grants.
 *
 *  Union, never difference. A grant only ever adds — see the note on the
 *  Capability enum in schema.prisma for why there is no negative grant. */
export function effectiveCapabilities(
  role: Role,
  grants: readonly Capability[],
): Capability[] {
  return inCanonicalOrder(new Set([...BASELINES[role], ...grants]));
}

export function isElevated(capability: Capability): boolean {
  return ELEVATED.includes(capability);
}

/** Whether a user may ask for this capability. Everything except the one
 *  everybody already holds — ADMINISTER included, since it is requestable but
 *  flagged (see isElevated). */
export function isRequestable(capability: Capability): boolean {
  return capability !== UNIVERSAL;
}
