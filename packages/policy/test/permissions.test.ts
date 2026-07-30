/**
 * EVIDENCE for Tech Design §03 — the permissions table itself.
 *
 * These tests belong to the policy package, not to the API: they assert
 * properties of the table that every consumer depends on. The API's own tests
 * cover the plugin that enforces it.
 */
import { describe, expect, it } from "vitest";
import { ROLES } from "@sr/envelope/core";
import {
  ACTIONS, actionsFor, APPROVER_ROLES, can, MIN_COMMITTEE_MEMBERS, PERMISSIONS, ROLE_COPY,
} from "../src/index.ts";

describe("deny by default", () => {
  it("refuses every action not explicitly granted", () => {
    for (const role of ROLES) {
      const granted = new Set(actionsFor(role));
      for (const action of ACTIONS) {
        expect(can(role, action).allowed).toBe(granted.has(action));
      }
    }
  });

  it("gives members no actions at all — they have no login in the MVP", () => {
    expect(actionsFor("member")).toHaveLength(0);
  });

  it("grants nothing for an action absent from the table", () => {
    // A new entry in ACTIONS must be granted deliberately; adding one cannot
    // silently open a door.
    const verdict = can("committee", "society.create");
    expect(verdict.allowed).toBe(false);
  });
});

describe("role boundaries the PRD states explicitly", () => {
  it("staff may not approve expenses (Story 1.3 · 2)", () => {
    expect(can("staff", "expense.approve").allowed).toBe(false);
  });

  it("staff may not see member balances (Story 1.3 · 2)", () => {
    expect(can("staff", "balance.read").allowed).toBe(false);
  });

  it("the accountant may read everything financial but create nothing (Story 1.3 · 3)", () => {
    expect(can("accountant", "expense.read").allowed).toBe(true);
    expect(can("accountant", "payment.read").allowed).toBe(true);
    expect(can("accountant", "balance.read").allowed).toBe(true);
    expect(can("accountant", "artifact.export").allowed).toBe(true);

    for (const action of ACTIONS) {
      if (/\.(create|approve|record|manage|upload|correct|revoke|change)/.test(action)) {
        expect(can("accountant", action).allowed).toBe(false);
      }
    }
  });

  it("only the committee confirms queued post-revocation entries (D-002)", () => {
    expect(can("committee", "syncqueue.confirm").allowed).toBe(true);
    for (const role of ROLES) {
      if (role !== "committee") expect(can(role, "syncqueue.confirm").allowed).toBe(false);
    }
  });

  it("staff corrections are scoped to their own entries (Flow D)", () => {
    expect(can("staff", "entry.correct")).toEqual({ allowed: true, scope: "own" });
    expect(can("committee", "entry.correct")).toEqual({ allowed: true, scope: "all" });
  });
});

describe("screen copy cannot drift from server behaviour", () => {
  it("every role has copy", () => {
    for (const role of ROLES) {
      expect(ROLE_COPY[role].label.length).toBeGreaterThan(0);
      expect(ROLE_COPY[role].can.length).toBeGreaterThan(0);
    }
  });

  it("says what staff cannot do, and the table agrees", () => {
    expect(ROLE_COPY.staff.cannot).toMatch(/cannot approve/i);
    expect(ROLE_COPY.staff.cannot).toMatch(/balances/i);
    expect(can("staff", "expense.approve").allowed).toBe(false);
    expect(can("staff", "balance.read").allowed).toBe(false);
  });

  it("says the accountant creates and approves nothing, and the table agrees", () => {
    expect(ROLE_COPY.accountant.cannot).toMatch(/cannot create or approve/i);
    expect(can("accountant", "expense.create").allowed).toBe(false);
    expect(can("accountant", "expense.approve").allowed).toBe(false);
  });

  it("says members do not sign in, and the table agrees", () => {
    expect(ROLE_COPY.member.cannot).toMatch(/does not sign in/i);
    expect(actionsFor("member")).toHaveLength(0);
  });

  it("never says 'office bearer' anywhere a user can see (PRD §1.4)", () => {
    expect(JSON.stringify(ROLE_COPY).toLowerCase()).not.toMatch(/office bearer/);
    expect(ROLE_COPY.committee.label).toBe("Committee");
  });
});

describe("the two-approver invariant (Flow C4e)", () => {
  it("names committee as the approving role and requires two", () => {
    expect(APPROVER_ROLES).toEqual(["committee"]);
    expect(MIN_COMMITTEE_MEMBERS).toBe(2);
  });

  it("keeps approval a committee-only power, so the guard means what it says", () => {
    const approvers = ROLES.filter((r) => PERMISSIONS[r]["expense.approve"] !== undefined);
    expect(approvers).toEqual(["committee"]);
  });
});
