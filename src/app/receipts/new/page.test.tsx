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
// Echoes exactly the props under test back into the DOM as data-attributes, so
// assertions read the same wiring NewReceiptPage actually computed — not a
// re-derivation of it.
vi.mock("./ReceiptBuilderForm", () => ({
  ReceiptBuilderForm: (props: { initialItems: { itemId: string }[]; draftId?: string; droppedItemCount?: number }) => (
    <div
      data-testid="builder"
      data-items={props.initialItems.map((i) => i.itemId).join(",")}
      data-draftid={props.draftId ?? ""}
      data-dropped={props.droppedItemCount ?? 0}
    />
  ),
}));

import NewReceiptPage from "./page";

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
describe("NewReceiptPage — the dropped-item count is draft-only", () => {
  it("reports zero dropped items on the plain ?items= path, even with a retired id among them", async () => {
    getItem.mockImplementation(async (id: string) => (id === "retired" ? item("retired", "RETIRED") : item(id)));

    const el = await NewReceiptPage({ searchParams: Promise.resolve({ items: "retired,active" }) });
    render(el);

    const builder = screen.getByTestId("builder");
    expect(builder.dataset.dropped).toBe("0");
    expect(builder.dataset.draftid).toBe("");
    expect(builder.dataset.items).toBe("active");
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
    expect(builder.dataset.dropped).toBe("0"); // not stale-reported as 1
  });
});
