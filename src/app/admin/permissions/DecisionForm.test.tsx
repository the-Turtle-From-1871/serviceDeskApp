// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/app/actions/permissions", () => ({
  decidePermissionRequestAction: vi.fn(),
}));

import { DecisionForm } from "./DecisionForm";

const CAPS = ["MANAGE_QUEUE", "PROCESS_RETURNS", "ADMINISTER"] as const;

const box = (label: RegExp) => screen.getByRole("checkbox", { name: label }) as HTMLInputElement;

beforeEach(() => {
  // Auto-cleanup is not wired up globally here, so renders would otherwise
  // accumulate across tests and every query would match twice.
  cleanup();
  vi.clearAllMocks();
});

describe("DecisionForm — the pre-checked checklist", () => {
  it("starts every ordinary capability CHECKED, so approving is the default", () => {
    render(<DecisionForm requestId="r1" capabilities={[...CAPS]} selfRequest={false} />);
    expect(box(/Manage the service queue/).checked).toBe(true);
    expect(box(/Process returns/).checked).toBe(true);
  });

  // Granting full administrative control should take a deliberate tick, not a
  // deliberate untick.
  it("starts ADMINISTER UNCHECKED", () => {
    render(<DecisionForm requestId="r1" capabilities={[...CAPS]} selfRequest={false} />);
    expect(box(/Grant Administrator/).checked).toBe(false);
  });

  it("labels the button with what is actually being granted", () => {
    render(<DecisionForm requestId="r1" capabilities={[...CAPS]} selfRequest={false} />);
    // Two of three, because ADMINISTER starts off.
    expect(screen.getByRole("button", { name: /Approve 2 of 3/ })).toBeTruthy();
  });

  it("says Deny all when nothing is checked", () => {
    render(<DecisionForm requestId="r1" capabilities={[...CAPS]} selfRequest={false} />);
    fireEvent.click(box(/Manage the service queue/));
    fireEvent.click(box(/Process returns/));
    expect(screen.getByRole("button", { name: /Deny all/ })).toBeTruthy();
  });

  it("counts up when an elevated capability is deliberately ticked", () => {
    render(<DecisionForm requestId="r1" capabilities={[...CAPS]} selfRequest={false} />);
    fireEvent.click(box(/Grant Administrator/));
    expect(screen.getByRole("button", { name: /Approve 3 of 3/ })).toBeTruthy();
  });

  // Unchecking IS denying, and a denial the requester cannot act on is a dead
  // end — so the reason appears the moment anything is cleared.
  it("reveals a REQUIRED reason field as soon as anything is unchecked", () => {
    render(<DecisionForm requestId="r1" capabilities={["MANAGE_QUEUE"]} selfRequest={false} />);
    expect(screen.queryByLabelText(/not granting the rest/i)).toBeNull();
    fireEvent.click(box(/Manage the service queue/));
    const reason = screen.getByLabelText(/not granting the rest/i) as HTMLTextAreaElement;
    expect(reason.required).toBe(true);
  });

  it("hides the reason field again when everything is re-checked", () => {
    render(<DecisionForm requestId="r1" capabilities={["MANAGE_QUEUE"]} selfRequest={false} />);
    fireEvent.click(box(/Manage the service queue/));
    fireEvent.click(box(/Manage the service queue/));
    expect(screen.queryByLabelText(/not granting the rest/i)).toBeNull();
  });

  it("shows no reason field when a request has only elevated lines left unchecked… until asked", () => {
    render(<DecisionForm requestId="r1" capabilities={["ADMINISTER"]} selfRequest={false} />);
    // ADMINISTER starts unchecked, so this is already a full denial.
    expect(screen.getByLabelText(/not granting the rest/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deny all/ })).toBeTruthy();
  });
});

describe("DecisionForm — self-request", () => {
  it("offers no controls at all for the admin's own request", () => {
    render(<DecisionForm requestId="r1" capabilities={[...CAPS]} selfRequest />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/self-grant/i)).toBeTruthy();
  });
});
