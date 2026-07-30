/**
 * EVIDENCE for Arch §04 layer 4 — the chain is what makes "no user, including
 * us as the vendor" a checkable property rather than a promise.
 */
import { describe, expect, it } from "vitest";
import { canonicalise, GENESIS_HASH, hashEntry, verifyChain, type ChainLink, type HashableEntry } from "../src/core/hashchain.ts";

const base: HashableEntry = {
  id: "11111111-1111-4111-8111-111111111111",
  societyId: "22222222-2222-4222-8222-222222222222",
  kind: "expense.created",
  actorId: "33333333-3333-4333-8333-333333333333",
  actorRole: "committee",
  occurredAt: "2026-06-12T02:10:00.000Z",
  recordedAt: "2026-06-12T02:10:04.000Z",
  content: "amount=1950000;vendor=Sharma Pumps",
};

function chainOf(entries: readonly HashableEntry[]): ChainLink[] {
  let prev = GENESIS_HASH;
  return entries.map((entry) => {
    const entryHash = hashEntry(entry, prev);
    const link: ChainLink = { id: entry.id, prevHash: prev, entryHash, entry };
    prev = entryHash;
    return link;
  });
}

describe("canonicalisation", () => {
  it("is length-prefixed so no value can fake a field boundary", () => {
    const a = canonicalise({ ...base, actorRole: "committee", content: "x" });
    const b = canonicalise({ ...base, actorRole: "committee|1:x", content: "" });
    expect(a).not.toBe(b);
  });

  it("is stable across runs", () => {
    expect(canonicalise(base)).toBe(canonicalise({ ...base }));
  });
});

describe("verification", () => {
  it("accepts a clean chain", () => {
    const links = chainOf([base, { ...base, id: "b", content: "amount=80000" }]);
    expect(verifyChain(links)).toEqual({ ok: true, length: 2 });
  });

  it("accepts the empty chain", () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  it("detects altered content and names the row", () => {
    const links = chainOf([base, { ...base, id: "b", content: "amount=80000" }]);
    links[1] = { ...links[1]!, entry: { ...links[1]!.entry, content: "amount=8000000" } };

    const verdict = verifyChain(links);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.brokenAt).toBe("b");
      expect(verdict.position).toBe(1);
      expect(verdict.reason).toMatch(/content altered/);
    }
  });

  it("detects a removed entry — the gap breaks the link", () => {
    const links = chainOf([base, { ...base, id: "b" }, { ...base, id: "c" }]);
    const withHole = [links[0]!, links[2]!];

    const verdict = verifyChain(withHole);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.brokenAt).toBe("c");
  });

  it("detects a forked chain — two entries claiming one parent", () => {
    // This is the concurrency defect the Tech Design §02 critique found;
    // the advisory lock in lock_chain() prevents it at write time.
    const links = chainOf([base, { ...base, id: "b" }]);
    const forked = [links[0]!, links[1]!, { ...links[1]!, id: "c" }];

    expect(verifyChain(forked).ok).toBe(false);
  });

  it("rejects a malformed prev_hash rather than hashing it", () => {
    expect(() => hashEntry(base, "not-a-hash")).toThrow(/64 lowercase hex/);
  });
});
