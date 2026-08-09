import { beforeEach, describe, expect, it, vi } from "vitest";

const requireCapability = vi.hoisted(() => vi.fn());
const requireAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authz", () => ({
  requireCapability: (...a: unknown[]) => requireCapability(...a),
  requireAdmin: () => requireAdmin(),
}));

const createPermissionRequest = vi.hoisted(() => vi.fn());
const decidePermissionRequest = vi.hoisted(() => vi.fn());
vi.mock("@/modules/users/permissions.service", () => ({
  createPermissionRequest: (...a: unknown[]) => createPermissionRequest(...a),
  decidePermissionRequest: (...a: unknown[]) => decidePermissionRequest(...a),
}));

const sendDecisionEmail = vi.hoisted(() => vi.fn());
vi.mock("@/modules/auth/send-decision-email", () => ({
  sendDecisionEmail: (a: unknown) => sendDecisionEmail(a),
}));

const deferred = vi.hoisted(() => [] as (() => Promise<void> | void)[]);
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => deferred.push(fn) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requestPermissionsAction, decidePermissionRequestAction } from "./permissions";
import { PermissionRequestError } from "@/modules/users/permissions.errors";

const JUSTIFICATION = "I have taken over returns processing for the shop this quarter.";

function requestForm(caps: string[] = ["PROCESS_RETURNS"], justification = JUSTIFICATION) {
  const fd = new FormData();
  fd.set("justification", justification);
  for (const c of caps) fd.append("capabilities", c);
  return fd;
}

async function runDeferred() {
  while (deferred.length) await deferred.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  deferred.length = 0;
  process.env.APP_URL = "https://www.dcsim.us";
  requireCapability.mockResolvedValue({ id: "u1", name: "Jane", capabilities: ["VIEW_INVENTORY"] });
  requireAdmin.mockResolvedValue({ id: "admin1", name: "Boss" });
  createPermissionRequest.mockResolvedValue({ id: "r1" });
  decidePermissionRequest.mockResolvedValue({
    id: "r1",
    denialReason: null,
    user: { email: "jane@unit.mil", name: "Jane" },
    items: [{ capability: "PROCESS_RETURNS", decision: "APPROVED" }],
  });
});

describe("requestPermissionsAction", () => {
  it("gates on a signed-in session, so a VIEWER can ask", async () => {
    await requestPermissionsAction(undefined, requestForm());
    expect(requireCapability).toHaveBeenCalledWith("VIEW_INVENTORY");
  });

  // A userId field would let anyone file a request in someone else's name, and
  // a justification attached to a grant is only meaningful if the person it
  // names actually wrote it.
  it("takes the requester from the SESSION, never from the form", async () => {
    const fd = requestForm();
    fd.set("userId", "someone-else");
    await requestPermissionsAction(undefined, fd);
    expect(createPermissionRequest.mock.calls[0][0]).toBe("u1");
  });

  it("rejects a justification that is too short, without calling the service", async () => {
    const res = await requestPermissionsAction(undefined, requestForm(["PROCESS_RETURNS"], "pls"));
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(createPermissionRequest).not.toHaveBeenCalled();
  });

  it("rejects a request for a capability nobody may request", async () => {
    const res = await requestPermissionsAction(undefined, requestForm(["VIEW_INVENTORY"]));
    expect(res).toMatchObject({ error: expect.any(String) });
    expect(createPermissionRequest).not.toHaveBeenCalled();
  });

  it("surfaces a known service refusal as a readable message", async () => {
    createPermissionRequest.mockRejectedValue(new PermissionRequestError("ALREADY_PENDING"));
    const res = await requestPermissionsAction(undefined, requestForm());
    expect(res).toMatchObject({ error: expect.stringContaining("already asked") });
  });

  it("returns a generic message and logs on an unexpected failure", async () => {
    createPermissionRequest.mockRejectedValue(new Error("db on fire"));
    const res = await requestPermissionsAction(undefined, requestForm());
    expect(res).toEqual({ error: "Something went wrong. Please try again." });
  });
});

describe("decidePermissionRequestAction", () => {
  function decisionForm(approve: string[], denialReason?: string) {
    const fd = new FormData();
    fd.set("requestId", "r1");
    for (const a of approve) fd.append("approve", a);
    if (denialReason) fd.set("denialReason", denialReason);
    return fd;
  }

  it("requires ADMINISTER", async () => {
    await decidePermissionRequestAction(undefined, decisionForm(["PROCESS_RETURNS"]));
    expect(requireAdmin).toHaveBeenCalledTimes(1);
  });

  // The service's self-decision guard is only meaningful if the decider comes
  // from the session — a form-supplied id would defeat it outright.
  it("takes the decider from the SESSION, never from the form", async () => {
    const fd = decisionForm(["PROCESS_RETURNS"]);
    fd.set("deciderId", "u1");
    await decidePermissionRequestAction(undefined, fd);
    expect(decidePermissionRequest.mock.calls[0][0].deciderId).toBe("admin1");
  });

  it("passes only the CHECKED capabilities as approved", async () => {
    await decidePermissionRequestAction(undefined, decisionForm(["MANAGE_QUEUE"], "rest denied"));
    expect(decidePermissionRequest.mock.calls[0][0].approve).toEqual(["MANAGE_QUEUE"]);
  });

  it("treats no checked boxes as a full denial rather than a parse error", async () => {
    await decidePermissionRequestAction(undefined, decisionForm([], "Not this quarter."));
    expect(decidePermissionRequest.mock.calls[0][0].approve).toEqual([]);
  });

  it("surfaces the self-decision refusal as a readable message", async () => {
    decidePermissionRequest.mockRejectedValue(new PermissionRequestError("SELF_DECISION"));
    const res = await decidePermissionRequestAction(undefined, decisionForm(["MANAGE_QUEUE"]));
    expect(res).toMatchObject({ error: expect.stringContaining("cannot decide your own") });
  });

  it("surfaces the missing-reason refusal", async () => {
    decidePermissionRequest.mockRejectedValue(new PermissionRequestError("REASON_REQUIRED"));
    const res = await decidePermissionRequestAction(undefined, decisionForm(["MANAGE_QUEUE"]));
    expect(res).toMatchObject({ error: expect.stringContaining("reason") });
  });

  it("emails the outcome after responding", async () => {
    await decidePermissionRequestAction(undefined, decisionForm(["PROCESS_RETURNS"]));
    expect(sendDecisionEmail).not.toHaveBeenCalled();
    await runDeferred();
    expect(sendDecisionEmail.mock.calls[0][0].approved).toEqual(["PROCESS_RETURNS"]);
  });

  // The decision has already committed; reporting a mail outage as a failure
  // would have the requester ask again and an admin grant it twice.
  it("swallows a mail failure — the decision already committed", async () => {
    sendDecisionEmail.mockRejectedValue(new Error("smtp down"));
    const res = await decidePermissionRequestAction(undefined, decisionForm(["PROCESS_RETURNS"]));
    expect(res).toEqual({ ok: true });
    await expect(runDeferred()).resolves.toBeUndefined();
  });

  it("does not schedule mail when no base URL is configured", async () => {
    delete process.env.APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    await decidePermissionRequestAction(undefined, decisionForm(["PROCESS_RETURNS"]));
    await runDeferred();
    expect(sendDecisionEmail).not.toHaveBeenCalled();
  });
});
