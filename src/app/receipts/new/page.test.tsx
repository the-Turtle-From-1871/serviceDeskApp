// @vitest-environment jsdom
//
// Server Component tests. NewReceiptPage is a plain async function with no
// client hooks of its own, so it can be invoked directly and its resolved JSX
// rendered with RTL — the same technique used across the App Router ecosystem
// for testing Server Components in isolation. `ReceiptBuilderForm` is mocked
// to a prop-echoing stub: what is under test here is the SERVER-SIDE wiring
// (which ids get loaded, what gets passed down), not the client form's own
// rendering — that is covered by ReceiptBuilderForm.drafts.test.tsx.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/authz", () => ({ requireUser: vi.fn(async () => ({ id: "u1", role: "USER", isActive: true })) }));
const getItem = vi.fn();
vi.mock("@/modules/items/items.service", () => ({ getItem: (id: string) => getItem(id) }));
vi.mock("@/modules/transfers/transfers.service", () => ({ getLastReceiver: vi.fn(async () => null) }));
vi.mock("@/modules/signatures/signatures.service", () => ({ listSignatures: vi.fn(async () => []) }));
const getDraft = vi.fn();
vi.mock("@/modules/receipts/drafts.service", () => ({ getDraft: (id: string, userId: string) => getDraft(id, userId) }));
vi.mock("@/components/SiteHeader", () => ({ SiteHeader: () => <div data-testid="site-header" /> }));
// page.tsx only ever passes this as a `<form action={...}>` reference in these
// tests — nothing here submits the form — so a bare stub is enough, and it
// keeps the real "use server" file (which imports server-only modules) out of
// this jsdom module graph entirely.
vi.mock("@/app/actions/drafts", () => ({ deleteDraftAction: vi.fn() }));
// Echoes exactly the props under test back into the DOM as data-attributes, so
// assertions read the same wiring NewReceiptPage actually computed — not a
// re-derivation of it.
vi.mock("./ReceiptBuilderForm", () => ({
  ReceiptBuilderForm: (props: { initialItems: { itemId: string }[]; draftId?: string; droppedItemsNotice?: string }) => (
    <div
      data-testid="builder"
      data-items={props.initialItems.map((i) => i.itemId).join(",")}
      data-draftid={props.draftId ?? ""}
      data-dropped-notice={props.droppedItemsNotice ?? ""}
    />
  ),
}));

import NewReceiptPage from "./page";
import { DraftError } from "@/modules/receipts/drafts.errors";

const item = (id: string, status: "ACTIVE" | "RETIRED" = "ACTIVE") => ({
  id, status, make: "Dell", model: "5420", serialNumber: `SN-${id}`,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Finding 2: splitDraftItems ran unconditionally, so a plain (non-draft)
// `?items=` link containing a since-retired id rendered a draft-worded
// "removed from this draft" alert with no draft in play — reachable from
// `/items` when a device is retired between page load and click.
describe("NewReceiptPage — the dropped-items notice is draft-only", () => {
  it("reports no dropped-items notice on the plain ?items= path, even with a retired id among them", async () => {
    getItem.mockImplementation(async (id: string) => (id === "retired" ? item("retired", "RETIRED") : item(id)));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ items: "retired,active" }) });
    render(el);

    const builder = screen.getByTestId("builder");
    expect(builder.dataset.droppedNotice).toBe("");
    expect(builder.dataset.draftid).toBe("");
    expect(builder.dataset.items).toBe("active");
  });
});

// Finding 5: the design spec (§4) calls for NAMING a dropped device, not just
// counting it — "SN ABC123 was retired and has been removed". The data was
// already fetched (getItem was called for every id) and discarded by the old
// filter; page.tsx now keeps it and classifies retired-vs-deleted.
describe("NewReceiptPage — the dropped-items notice names what it can", () => {
  it("names a single retired device by serial and make/model", async () => {
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: ["i1", "i2"], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });
    getItem.mockImplementation(async (id: string) => (id === "i2" ? item("i2", "RETIRED") : item(id)));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ draft: "d1" }) });
    render(el);

    const notice = screen.getByTestId("builder").dataset.droppedNotice;
    expect(notice).toMatch(/SN-i2/);
    expect(notice).toMatch(/Dell 5420/);
  });

  it("names a retired device AND accounts for one deleted outright, without inventing an identifier for the deleted one", async () => {
    // i2 was retired (nameable — still a row, just not ACTIVE); i3 was
    // deleted from inventory entirely (getItem resolves null — no row, so
    // nothing to name). Both must be reported; neither silently dropped.
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: ["i1", "i2", "i3"], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });
    getItem.mockImplementation(async (id: string) => {
      if (id === "i2") return item("i2", "RETIRED");
      if (id === "i3") return null;
      return item(id);
    });

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ draft: "d1" }) });
    render(el);

    const notice = screen.getByTestId("builder").dataset.droppedNotice;
    expect(notice).toMatch(/SN-i2/); // the retired one is named
    expect(notice).not.toMatch(/SN-i3/); // there is no such serial to invent
    expect(notice).toMatch(/1 device.*no longer in inventory/); // the deleted one is still accounted for
    expect(screen.getByTestId("builder").dataset.items).toBe("i1"); // only the survivor loads
  });
});

// Finding 3: with a draft bound, `ids` came from `draft.payload.itemIds` and
// `?items=` was ignored outright — but ReceiptBuilderForm's `replaceState`
// effect keeps writing the LIVE list to `?items=` on every change. Resuming
// draft d1 (i1), scanning i2, then reloading (an iOS tab eviction is exactly
// this) silently dropped i2: the very case that effect exists to survive.
describe("NewReceiptPage — the URL wins over the draft payload when both are present", () => {
  it("loads a post-resume scanned item that only the URL knows about", async () => {
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: ["i1"], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });
    getItem.mockImplementation(async (id: string) => item(id));

    // The client wrote `?items=i1,i2&draft=d1` after the scan; a reload hits
    // the server with both.
    const el = await NewReceiptPage({ searchParams: Promise.resolve({ items: "i1,i2", draft: "d1" }) });
    render(el);

    const builder = screen.getByTestId("builder");
    expect(builder.dataset.items).toBe("i1,i2"); // i2 survives — NOT dropped by preferring the stale payload
    expect(builder.dataset.draftid).toBe("d1"); // still bound to the same draft
  });

  it("falls back to the draft payload when the URL carries no ?items= (resuming from /account)", async () => {
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: ["i1", "i2"], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });
    getItem.mockImplementation(async (id: string) => item(id));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ draft: "d1" }) });
    render(el);

    expect(screen.getByTestId("builder").dataset.items).toBe("i1,i2");
  });

  it("does not re-report a device as dropped once the URL has already dropped it", async () => {
    // The draft payload still names a retired item (i2), but the live URL —
    // written by the client after the FIRST render already warned about it —
    // no longer carries it. Recomputing `droppedIds` against the stale
    // payload would re-surface a warning the operator already dismissed.
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: ["i1", "i2"], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });
    getItem.mockImplementation(async (id: string) => item(id));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ items: "i1", draft: "d1" }) });
    render(el);

    const builder = screen.getByTestId("builder");
    expect(builder.dataset.items).toBe("i1");
    expect(builder.dataset.droppedNotice).toBe(""); // not stale-reported
  });
});

// Finding 3: the spec (§4.4) requires an explanatory card — never a bare
// notFound(), never an empty builder — and a Delete button on every terminal
// card, matching /account's own Delete button.
describe("NewReceiptPage — terminal draft cards never dead-end without a way out", () => {
  it("renders an explanatory card with a Delete button for a draft that can no longer be read, instead of throwing", async () => {
    getDraft.mockRejectedValue(new DraftError("CORRUPT"));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ draft: "d1" }) });
    render(el);

    expect(screen.getByText(/can no longer be read/i)).toBeTruthy();
    const del = screen.getByRole("button", { name: /delete this draft/i });
    const form = del.closest("form") as HTMLFormElement;
    expect((form.querySelector('input[name="id"]') as HTMLInputElement).value).toBe("d1");
  });

  it("renders an explanatory card with a Delete button when every device on the draft is gone, instead of a bare 404", async () => {
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: ["i1", "i2"], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });
    getItem.mockImplementation(async (id: string) => item(id, "RETIRED"));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ draft: "d1" }) });
    render(el);

    expect(screen.getByText(/None of the 2 devices/i)).toBeTruthy();
    const del = screen.getByRole("button", { name: /delete this draft/i });
    const form = del.closest("form") as HTMLFormElement;
    expect((form.querySelector('input[name="id"]') as HTMLInputElement).value).toBe("d1");
  });

  // A draft can be SAVED with zero items (removeItem can empty the builder's
  // list before "Save draft"), and the schema permits `itemIds: []`. Resuming
  // one used to fall through to a bare notFound() — the exact "empty builder /
  // bare 404" pairing the spec forbids.
  it("renders an explanatory card with a Delete button for a draft saved with zero items, instead of 404ing", async () => {
    getDraft.mockResolvedValue({ id: "d1", payload: { itemIds: [], lines: [], sender: {}, receiver: {}, returnDays: "", service: [] }, updatedAt: new Date() });

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ draft: "d1" }) });
    render(el);

    expect(screen.getByText(/no items saved/i)).toBeTruthy();
    expect(getItem).not.toHaveBeenCalled(); // nothing to even try loading
    const del = screen.getByRole("button", { name: /delete this draft/i });
    const form = del.closest("form") as HTMLFormElement;
    expect((form.querySelector('input[name="id"]') as HTMLInputElement).value).toBe("d1");
  });
});
