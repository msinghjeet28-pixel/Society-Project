/**
 * EVIDENCE for the money guardrail (Tech Design §02).
 *
 * "A wrong receipt or balance is treated as the most severe class of bug."
 * These tests exist to make the float-rupee bug impossible to introduce
 * quietly rather than to demonstrate arithmetic.
 */
import { describe, expect, it } from "vitest";
import {
  add, compare, formatRupees, fromWire, MoneyError, paise, rupeesToPaise, subtract, sum, toWire,
} from "../src/core/money.ts";

describe("construction", () => {
  it("accepts whole paise", () => {
    expect(paise(1950000n)).toBe(1950000n);
    expect(paise(0)).toBe(0n);
  });

  it("rejects fractional paise — the float bug at its source", () => {
    expect(() => paise(19500.5)).toThrow(MoneyError);
    expect(() => paise(0.1 + 0.2)).toThrow(MoneyError);
  });

  it("rejects negative money", () => {
    expect(() => paise(-1)).toThrow(/negative/);
  });
});

describe("parsing what a treasurer actually types", () => {
  it.each([
    ["19500", 1950000n],
    ["19,500", 1950000n],
    ["₹19,500", 1950000n],
    ["19500.50", 1950050n],
    ["19,500.5", 1950050n],
    [" 800 ", 80000n],
  ])("parses %s", (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it("rejects anything ambiguous rather than guessing", () => {
    for (const bad of ["", "abc", "19.500", "19500.123", "-500", "1e5"]) {
      expect(() => rupeesToPaise(bad)).toThrow(MoneyError);
    }
  });

  it("does not lose the third decimal by rounding — it refuses", () => {
    // A silent round here is exactly how balances drift.
    expect(() => rupeesToPaise("100.999")).toThrow(MoneyError);
  });
});

describe("arithmetic stays exact", () => {
  it("sums a hundred ₹19,500.33 expenses without drift", () => {
    const one = rupeesToPaise("19500.33");
    const total = sum(Array.from({ length: 100 }, () => one));
    expect(total).toBe(195003300n);
    // The float equivalent: 19500.33 * 100 === 1950032.9999999998
    expect(Number(total) / 100).not.toBe(19500.33 * 100);
  });

  it("adds and subtracts", () => {
    expect(add(paise(100n), paise(250n))).toBe(350n);
    expect(subtract(paise(350n), paise(250n))).toBe(100n);
  });

  it("refuses to go negative on subtraction", () => {
    expect(() => subtract(paise(100n), paise(250n))).toThrow(/negative/);
  });

  it("compares without float comparison hazards", () => {
    expect(compare(paise(100n), paise(250n))).toBe(-1);
    expect(compare(paise(250n), paise(250n))).toBe(0);
  });
});

describe("Indian display formatting", () => {
  it.each([
    [1950000n, "₹19,500.00"],
    [80000n, "₹800.00"],
    [53040000n, "₹5,30,400.00"],   // lakh grouping, not ₹530,400
    [1234567890n, "₹1,23,45,678.90"], // crore grouping
    [50n, "₹0.50"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRupees(paise(value))).toBe(expected);
  });

  it("matches the prototype's ₹5,30,400 exactly", () => {
    expect(formatRupees(paise(53040000n), { paise: false })).toBe("₹5,30,400");
  });
});

describe("the wire", () => {
  it("round-trips as a string, never a JSON number", () => {
    const value = rupeesToPaise("19500.33");
    const wire = toWire(value);
    expect(typeof wire).toBe("string");
    expect(fromWire(wire)).toBe(value);
  });

  it("round-trips the largest legal amount", () => {
    // ₹10,000 crore — far above any society, and the sanity cap. Note this is
    // below Number.MAX_SAFE_INTEGER, so paise never needs more than 53 bits:
    // strings on the wire are not about magnitude, they are about stopping a
    // JSON number from inviting float arithmetic downstream.
    const max = paise(10_000_000_000_000n);
    expect(fromWire(toWire(max))).toBe(max);
  });

  it("refuses an implausible amount rather than storing it", () => {
    expect(() => paise(10_000_000_000_001n)).toThrow(/sane maximum/);
  });

  it("rejects a float that arrived on the wire", () => {
    expect(() => fromWire("195.33")).toThrow(MoneyError);
  });
});
