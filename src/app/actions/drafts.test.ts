import { describe, it, expect, vi, beforeEach } from "vitest";

const requireUser = vi.fn();
const saveDraft = vi.fn();
const deleteDraft = vi.fn();

vi.mock("@/lib/authz", () => ({
  requireUser: () => requireUser(),
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/modules/receipts/drafts.service", () => ({
  saveDraft: (...a: unknown[]) => saveDraft(...a),
  deleteDraft: (...a: unknown[]) => deleteDraft(...a),
  MAX_DRAFTS_PER_USER: 25,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// Matches the established pattern in unlock.test.ts: `redirect()` in real
// Next.js throws a digest-tagged control-flow error rather than returning, so
// the mock reproduces that shape instead of silently no-op'ing (which would
// let a test pass even if the action forgot to redirect at all).
const redirectMock = vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`); });
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirectMock(u) }));

import { saveDraftAction, deleteDraftAction, deleteDraftAndReturnToAccountAction } from "./drafts";
import { draftPayloadFromForm } from "@/modules/receipts/drafts.form";
import { DraftError } from "@/modules/receipts/drafts.errors";

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "u1", role: "USER" });
  saveDraft.mockResolvedValue({ id: "d1", updatedAt: new Date("2026-08-06T10:00:00Z") });
});

function form(entries: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("draftPayloadFromForm", () => {
  it("NEVER includes the recipient signature, even when the form posts one", () => {
    const fd = form([
      ["receiverSignature", "data:image/png;base64,AAAA"],
      ["receiverName", "Doe, Jane"],
    ]);
    expect(JSON.stringify(draftPayloadFromForm(fd))).not.toContain("data:image/png");
  });

  it("captures item ids, both parties, quantities, return days and service rows", () => {
    const fd = form([
      ["itemId", "i1"],
      ["itemId", "i2"],
      ["senderIsDcsim", "on"],
      ["senderName", "SGT Smith"],
      ["receiverName", "Doe, Jane"],
      ["receiverUnit", "A Co"],
      ["line[0][make]", "Dell"],
      ["line[0][model]", "5420"],
      ["line[0][qtyAuth]", "2"],
      ["line[0][qtyIssued]", "2"],
      ["returnDays", "7"],
      ["service[i1][needs]", "on"],
      ["service[i1][type]", "OTHER"],
      ["service[i1][note]", "cracked screen"],
      ["service[i1][days]", "5"],
    ]);
    const p = draftPayloadFromForm(fd) as ReturnType<typeof draftPayloadFromForm> & Record<string, never>;
    expect(p).toMatchObject({
      itemIds: ["i1", "i2"],
      sender: { isDcsim: true, name: "SGT Smith" },
      receiver: { isDcsim: false, name: "Doe, Jane", unit: "A Co" },
      lines: [{ make: "Dell", model: "5420", qtyAuth: "2", qtyIssued: "2" }],
      returnDays: "7",
      service: [{ itemId: "i1", serviceType: "OTHER", note: "cracked screen", days: "5" }],
    });
  });
});

describe("saveDraftAction", () => {
  it("saves under the acting user's id and returns the new draft id", async () => {
    const r = await saveDraftAction(undefined, form([["receiverName", "Doe, Jane"]]));
    expect(saveDraft).toHaveBeenCalledWith("u1", expect.objectContaining({ receiver: expect.objectContaining({ name: "Doe, Jane" }) }), undefined);
    expect(r).toMatchObject({ draftId: "d1" });
  });

  it("passes an existing draftId through so a re-save updates in place", async () => {
    await saveDraftAction(undefined, form([["draftId", "d9"], ["receiverName", "X"]]));
    expect(saveDraft).toHaveBeenCalledWith("u1", expect.anything(), "d9");
  });

  it("reports the per-user cap in plain language", async () => {
    saveDraft.mockRejectedValueOnce(new DraftError("TOO_MANY"));
    expect(await saveDraftAction(undefined, form([]))).toEqual({
      error: "You have 25 saved drafts — delete one before saving another.",
    });
  });

  it("returns a generic message and logs on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    saveDraft.mockRejectedValueOnce(new Error("boom"));
    expect(await saveDraftAction(undefined, form([]))).toEqual({
      error: "Something went wrong saving the draft. Please try again.",
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("never saves when the session is rejected", async () => {
    requireUser.mockRejectedValueOnce(new Error("FORBIDDEN"));
    await expect(saveDraftAction(undefined, form([]))).rejects.toThrow();
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe("deleteDraftAction", () => {
  it("deletes scoped to the acting user", async () => {
    await deleteDraftAction(form([["id", "d1"]]));
    expect(deleteDraft).toHaveBeenCalledWith("d1", "u1");
  });

  it("is a no-op with no id", async () => {
    await deleteDraftAction(form([]));
    expect(deleteDraft).not.toHaveBeenCalled();
  });

  // A DB blip must not throw unhandled out of a plain form action — that
  // takes out /account via the error boundary. Matches deleteSignatureAction's
  // best-effort shape.
  it("does not throw when the delete fails, and logs it instead", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteDraft.mockRejectedValueOnce(new Error("boom"));
    await expect(deleteDraftAction(form([["id", "d1"]]))).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // deleteDraftAction itself must NEVER redirect — it is shared with
  // DraftList.tsx's own Delete button on /account, whose flow (and the tests
  // above) assume a plain resolving Promise.
  it("never redirects", async () => {
    await deleteDraftAction(form([["id", "d1"]]));
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

// Item B: the /receipts/new terminal cards (corrupt / all-items-gone /
// zero-items) used the shared deleteDraftAction, so a successful delete just
// re-rendered the page straight into notFound() (or, for the corrupt card,
// the same card again) — the operator acted and landed on a 404. This
// dedicated action deletes exactly like deleteDraftAction, then redirects to
// /account, WITHOUT changing deleteDraftAction's own contract (see the "never
// redirects" test above).
describe("deleteDraftAndReturnToAccountAction", () => {
  it("deletes scoped to the acting user, then redirects to /account", async () => {
    await expect(deleteDraftAndReturnToAccountAction(form([["id", "d1"]])))
      .rejects.toThrow("REDIRECT:/account");
    expect(deleteDraft).toHaveBeenCalledWith("d1", "u1");
  });

  it("still redirects even when the delete fails, matching deleteDraftAction's own best-effort swallow", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteDraft.mockRejectedValueOnce(new Error("boom"));
    await expect(deleteDraftAndReturnToAccountAction(form([["id", "d1"]])))
      .rejects.toThrow("REDIRECT:/account");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
