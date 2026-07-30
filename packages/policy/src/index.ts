import { ROLES, type Role } from "@sr/envelope/core";

/**
 * Permissions as data (Arch §07).
 *
 * Two things depend on this single table, which is why it is a package and not
 * a file inside the API:
 *
 *   1. Every route's authorisation check.
 *   2. The plain-language sentence shown under each role when adding a person
 *      (Flow C2) — generated here, so screen copy and server behaviour cannot
 *      drift apart.
 *
 * The MVP has four fixed roles and nothing to configure, so this is a constant
 * rather than a per-society table. Keeping it in one shape means adding a
 * permission is a one-line diff a reviewer can actually check.
 */

export const ACTIONS = [
  // Society & people
  "society.create",
  "society.read",
  "person.add",
  "person.role.change",
  "person.role.revoke",
  "person.read",
  "flat.import",
  "flat.export",
  // Complaints
  "complaint.create",
  "complaint.read",
  "complaint.event.add",
  "complaint.resolve",
  // Expenses
  "expense.create",
  "expense.create.pettycash",
  "expense.approve",
  "expense.read",
  // Dues & payments
  "dues.manage",
  "payment.record",
  "payment.read",
  "balance.read",
  // Artifacts
  "artifact.export",
  "summary.generate",
  "document.upload",
  "document.read",
  // Corrections & disputes
  "entry.correct",
  "approval.object",
  // Queued-entry confirmation (Arch §14 №2)
  "syncqueue.confirm",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * `own` means the actor may act only on entries they created — used for staff
 * correcting their own entries (Flow D applies to "Staff, for their own
 * entries").
 */
export type Grant = true | "own";

type Matrix = Readonly<Record<Role, Readonly<Partial<Record<Action, Grant>>>>>;

export const PERMISSIONS: Matrix = {
  committee: {
    "society.read": true,
    "person.add": true,
    "person.role.change": true,
    "person.role.revoke": true,
    "person.read": true,
    "flat.import": true,
    "flat.export": true,
    "complaint.create": true,
    "complaint.read": true,
    "complaint.event.add": true,
    "complaint.resolve": true,
    "expense.create": true,
    "expense.approve": true,
    "expense.read": true,
    "dues.manage": true,
    "payment.record": true,
    "payment.read": true,
    "balance.read": true,
    "artifact.export": true,
    "summary.generate": true,
    "document.upload": true,
    "document.read": true,
    "entry.correct": true,
    "approval.object": true,
    "syncqueue.confirm": true,
  },
  staff: {
    "society.read": true,
    "person.read": true,
    "complaint.create": true,
    "complaint.read": true,
    "complaint.event.add": true,
    "complaint.resolve": true,
    "expense.create.pettycash": true,
    "expense.read": true,
    // Staff may correct their own entries, never anyone else's (Flow D).
    "entry.correct": "own",
  },
  accountant: {
    "society.read": true,
    "person.read": true,
    "complaint.read": true,
    "expense.read": true,
    "payment.read": true,
    "balance.read": true,
    "artifact.export": true,
    "document.read": true,
  },
  // Members have no login in the MVP. The empty object is the point: it makes
  // "member" a real row in the matrix test rather than an absence nobody checks.
  member: {},
} as const;

export type PolicyVerdict =
  | { allowed: true; scope: "all" | "own" }
  | { allowed: false; reason: string };

/**
 * The single authorisation function. Deny by default: an action absent from a
 * role's map is refused, so adding an action to ACTIONS without granting it
 * cannot accidentally open a door.
 */
export function can(role: Role, action: Action): PolicyVerdict {
  const grant = PERMISSIONS[role][action];
  if (grant === true) return { allowed: true, scope: "all" };
  if (grant === "own") return { allowed: true, scope: "own" };
  return { allowed: false, reason: `${role} may not ${action}` };
}

export function actionsFor(role: Role): readonly Action[] {
  return ACTIONS.filter((a) => PERMISSIONS[role][a] !== undefined);
}

/**
 * Plain-language permission sentences (Flow C2).
 *
 * These are the strings shown under each role when adding a person. They are
 * hand-written for dignity and clarity — a generated sentence reads like a
 * permissions matrix, which is exactly what the PRD's vocabulary rule forbids
 * — but each one is asserted against the matrix by a test, so a permission
 * change that contradicts its sentence fails CI.
 */
export const ROLE_COPY: Readonly<
  Record<Role, { label: string; can: string; cannot: string }>
> = {
  committee: {
    label: "Committee",
    can: "Can approve expenses, manage dues, add people, and create every report.",
    cannot: "",
  },
  staff: {
    label: "Staff",
    can: "Can log and resolve complaints, and record cash expenses up to the society's limit.",
    cannot: "Cannot approve expenses or see member balances.",
  },
  accountant: {
    label: "Accountant",
    can: "Can see all financial records and download exports.",
    cannot: "Cannot create or approve anything.",
  },
  member: {
    label: "Member",
    can: "Receives bills, receipts, and updates on their phone.",
    cannot: "Does not sign in — everything arrives as a message or a link.",
  },
} as const;

/** Roles that count toward the two-committee-member guard (Flow C4e). */
export const APPROVER_ROLES: readonly Role[] = ["committee"];
export const MIN_COMMITTEE_MEMBERS = 2;

export { ROLES, type Role };
