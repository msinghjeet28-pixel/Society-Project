/**
 * EVIDENCE for Story 1.2 — login without passwords.
 *
 * A six-digit code is only as good as the limits around it. These tests attack
 * the ways a code becomes guessable: unlimited attempts, unlimited requests,
 * codes that outlive their moment, and codes readable from the database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  CODE_TTL_MS, MAX_ATTEMPTS, PHONE_LIMIT, generateCode, issueChallenge, verifyChallenge,
} from "../src/auth/otp.ts";
import { ownerClient, resetWorld } from "./helpers/db.ts";

process.env["JWT_SIGNING_KEY"] ??= "test-signing-key-at-least-32-characters-long";

let owner: pg.Client;
const PHONE = "+919810000001";

beforeAll(async () => {
  owner = ownerClient();
  await owner.connect();
});

afterAll(async () => {
  await resetWorld(owner);
  await owner.end();
});

beforeEach(async () => {
  await owner.query("TRUNCATE otp_challenge");
});

describe("code generation", () => {
  it("is always six digits, including when the number is small", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("does not obviously repeat", () => {
    const codes = new Set(Array.from({ length: 100 }, generateCode));
    // Birthday collisions are possible; a near-constant generator is not.
    expect(codes.size).toBeGreaterThan(90);
  });
});

describe("the happy path", () => {
  it("issues a code and accepts it once", async () => {
    const issued = await issueChallenge(owner, { phone: PHONE });
    await expect(verifyChallenge(owner, { phone: PHONE, code: issued.code })).resolves.toEqual({
      phone: PHONE,
    });
  });

  it("refuses the same code a second time", async () => {
    const issued = await issueChallenge(owner, { phone: PHONE });
    await verifyChallenge(owner, { phone: PHONE, code: issued.code });

    await expect(verifyChallenge(owner, { phone: PHONE, code: issued.code })).rejects.toMatchObject(
      { code: "no_challenge" },
    );
  });
});

describe("the code is not readable from the database", () => {
  it("stores a hash, not the code", async () => {
    const issued = await issueChallenge(owner, { phone: PHONE });
    const { rows } = await owner.query<{ code_hash: Buffer }>(
      "SELECT code_hash FROM otp_challenge ORDER BY created_at DESC LIMIT 1",
    );
    const stored = rows[0]!.code_hash.toString("hex");
    expect(stored).not.toContain(issued.code);
    expect(rows[0]!.code_hash).toHaveLength(32); // sha256
  });

  it("binds the hash to the phone, so a code cannot be replayed elsewhere", async () => {
    const issued = await issueChallenge(owner, { phone: PHONE });
    const otherPhone = "+919820000002";
    await issueChallenge(owner, { phone: otherPhone });

    // The right code, but for the wrong number.
    await expect(
      verifyChallenge(owner, { phone: otherPhone, code: issued.code }),
    ).rejects.toMatchObject({ code: "wrong_code" });
  });
});

describe("attempt limits", () => {
  it("burns the challenge after three wrong guesses", async () => {
    const issued = await issueChallenge(owner, { phone: PHONE });
    const wrong = issued.code === "000000" ? "111111" : "000000";

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await expect(verifyChallenge(owner, { phone: PHONE, code: wrong })).rejects.toMatchObject({
        code: "wrong_code",
      });
    }

    // Even the correct code no longer works — the attacker cannot keep going,
    // and the real user requests a fresh code.
    await expect(
      verifyChallenge(owner, { phone: PHONE, code: issued.code }),
    ).rejects.toMatchObject({ code: "exhausted" });
  });
});

describe("expiry", () => {
  it("refuses a code past its five minutes", async () => {
    const past = new Date(Date.now() - CODE_TTL_MS - 1000);
    const issued = await issueChallenge(owner, { phone: PHONE }, past);

    await expect(
      verifyChallenge(owner, { phone: PHONE, code: issued.code }),
    ).rejects.toMatchObject({ code: "expired" });
  });
});

describe("rate limits", () => {
  it("stops flooding one number with real SMS", async () => {
    for (let i = 0; i < PHONE_LIMIT; i++) {
      await issueChallenge(owner, { phone: PHONE });
    }
    await expect(issueChallenge(owner, { phone: PHONE })).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("counts per number, so one busy society does not lock out another", async () => {
    for (let i = 0; i < PHONE_LIMIT; i++) {
      await issueChallenge(owner, { phone: PHONE });
    }
    await expect(issueChallenge(owner, { phone: "+919830000003" })).resolves.toBeDefined();
  });

  it("stops one address walking a range of numbers", async () => {
    const ip = "203.0.113.7";
    // Different numbers each time, so only the IP limit can stop this.
    for (let i = 0; i < 12; i++) {
      await issueChallenge(owner, { phone: `+9198100${String(10000 + i)}`, ip });
    }
    await expect(
      issueChallenge(owner, { phone: "+919810099999", ip }),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("the voice fallback", () => {
  it("records how the code travelled", async () => {
    await issueChallenge(owner, { phone: PHONE, channel: "voice" });
    const { rows } = await owner.query<{ channel: string }>(
      "SELECT channel FROM otp_challenge ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]!.channel).toBe("voice");
  });

  it("supports manual issuance for assisted onboarding while DLT is pending", async () => {
    await issueChallenge(owner, { phone: PHONE, channel: "manual" });
    const { rows } = await owner.query<{ channel: string }>(
      "SELECT channel FROM otp_challenge ORDER BY created_at DESC LIMIT 1",
    );
    expect(rows[0]!.channel).toBe("manual");
  });
});

describe("unknown numbers", () => {
  it("verifies a code for a number in no society — the dead end is downstream", async () => {
    // The request endpoint must not reveal whether a number is registered;
    // that would turn it into a directory. Verification therefore succeeds and
    // the "ask your committee" message comes after (Flow B2e).
    const unknown = "+919999999999";
    const issued = await issueChallenge(owner, { phone: unknown });
    await expect(
      verifyChallenge(owner, { phone: unknown, code: issued.code }),
    ).resolves.toEqual({ phone: unknown });
  });
});
