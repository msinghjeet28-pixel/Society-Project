import { createHash } from "node:crypto";

/**
 * Per-society hash chain (Arch §04, layer 4).
 *
 * This is what converts "no user, including us as the vendor, can edit an
 * entry" from a policy into a checkable property: any silent alteration
 * breaks verification from that row forward, and the nightly job finds it.
 *
 * The canonical form is deliberately explicit rather than JSON.stringify of a
 * whole row — key order and incidental columns must never affect the hash, or
 * a harmless refactor invalidates every historical chain.
 */

export const GENESIS_HASH = "0".repeat(64);

/** The fields that are hashed. Adding a field here is a breaking change. */
export interface HashableEntry {
  id: string;
  societyId: string;
  kind: string;
  actorId: string;
  actorRole: string;
  occurredAt: string;
  recordedAt: string;
  /** Entity-specific content, already canonicalised by the caller. */
  content: string;
  correctsId?: string | undefined;
}

/**
 * Deterministic serialisation: fixed field order, length-prefixed values so
 * no value can impersonate a field boundary ("a|b" vs "a" + "|b").
 */
export function canonicalise(entry: HashableEntry): string {
  const fields: readonly string[] = [
    entry.id,
    entry.societyId,
    entry.kind,
    entry.actorId,
    entry.actorRole,
    entry.occurredAt,
    entry.recordedAt,
    entry.content,
    entry.correctsId ?? "",
  ];
  return fields.map((f) => `${f.length}:${f}`).join("|");
}

export function hashEntry(entry: HashableEntry, prevHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(prevHash)) {
    throw new Error(`prevHash must be 64 lowercase hex chars, got: ${prevHash}`);
  }
  return createHash("sha256")
    .update(prevHash, "hex")
    .update(canonicalise(entry), "utf8")
    .digest("hex");
}

export interface ChainLink {
  id: string;
  prevHash: string;
  entryHash: string;
  entry: HashableEntry;
}

export type ChainVerdict =
  | { ok: true; length: number }
  | { ok: false; brokenAt: string; reason: string; position: number };

/**
 * Walk a society's chain in recorded order. Returns the first break, which is
 * the row to investigate — everything after it is suspect by construction.
 */
export function verifyChain(links: readonly ChainLink[]): ChainVerdict {
  let expectedPrev = GENESIS_HASH;

  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;

    if (link.prevHash !== expectedPrev) {
      return {
        ok: false,
        brokenAt: link.id,
        position: i,
        reason: `prev_hash mismatch: chain expected ${expectedPrev.slice(0, 12)}…, row claims ${link.prevHash.slice(0, 12)}…`,
      };
    }

    const recomputed = hashEntry(link.entry, link.prevHash);
    if (recomputed !== link.entryHash) {
      return {
        ok: false,
        brokenAt: link.id,
        position: i,
        reason: `content altered: stored hash ${link.entryHash.slice(0, 12)}… does not match recomputed ${recomputed.slice(0, 12)}…`,
      };
    }

    expectedPrev = link.entryHash;
  }

  return { ok: true, length: links.length };
}
