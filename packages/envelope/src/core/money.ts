/**
 * Money is integer paise, always. The PRD classifies a wrong balance as the
 * most severe bug class; float rupees is the usual way teams create that bug
 * without noticing for months.
 *
 * The branded type means a plain number cannot be passed where money is
 * expected, so the compiler catches the mistake the ESLint money rule is the
 * second line of defence against.
 */

declare const paiseBrand: unique symbol;

export type Paise = bigint & { readonly [paiseBrand]: true };

const MAX_PAISE = 10_000_000_000_000n; // ₹1,00,00,00,00,000 — far above any society

export class MoneyError extends Error {}

/** Construct paise from an integer. Rejects anything that is not a safe integer. */
export function paise(value: bigint | number): Paise {
  const v = typeof value === "number" ? numberToBigint(value) : value;
  if (v < 0n) throw new MoneyError(`money cannot be negative: ${v}`);
  if (v > MAX_PAISE) throw new MoneyError(`money exceeds sane maximum: ${v}`);
  return v as Paise;
}

function numberToBigint(value: number): bigint {
  if (!Number.isInteger(value)) {
    throw new MoneyError(
      `paise must be a whole number, got ${value} — rupee amounts must be converted with rupeesToPaise()`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`paise outside safe integer range: ${value}`);
  }
  return BigInt(value);
}

/**
 * Parse a rupee amount typed by a human ("19500", "19,500.50", "₹19500")
 * into paise without ever going through a float.
 */
export function rupeesToPaise(input: string): Paise {
  const cleaned = input.replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyError(`not a rupee amount: ${JSON.stringify(input)}`);
  }
  const [whole = "0", frac = ""] = cleaned.split(".");
  const paiseFrac = frac.padEnd(2, "0");
  return paise(BigInt(whole) * 100n + BigInt(paiseFrac));
}

export function add(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function subtract(a: Paise, b: Paise): Paise {
  return paise(a - b);
}

export function sum(values: readonly Paise[]): Paise {
  return paise(values.reduce<bigint>((acc, v) => acc + v, 0n));
}

export function isZero(a: Paise): boolean {
  return a === 0n;
}

export function compare(a: Paise, b: Paise): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Indian-format display, e.g. 1950000n -> "₹19,500.00".
 * Grouping is 2,2,3 from the right (lakh/crore), not 3,3,3.
 */
export function formatRupees(value: Paise, opts?: { paise?: boolean }): string {
  const showPaise = opts?.paise ?? true;
  const whole = value / 100n;
  const frac = value % 100n;
  const digits = whole.toString();

  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
  }

  return showPaise
    ? `₹${grouped}.${frac.toString().padStart(2, "0")}`
    : `₹${grouped}`;
}

/** For persistence: paise cross the wire as a decimal string, never a JSON number. */
export function toWire(value: Paise): string {
  return value.toString();
}

export function fromWire(value: string): Paise {
  if (!/^\d+$/.test(value)) throw new MoneyError(`bad paise on wire: ${value}`);
  return paise(BigInt(value));
}
