import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Access tokens.
 *
 * Deliberately NOT JWT. JWT's algorithm field is the source of a whole class
 * of vulnerability (alg confusion, `alg: none`), and we control both ends of
 * this token, so the flexibility buys nothing. What ships instead is one fixed
 * scheme — HMAC-SHA256 over a compact JSON payload — which is small enough to
 * audit in one sitting and has no negotiable parts.
 *
 * The token carries the membership version it was minted with. Every request
 * compares that against the society's current version, which is what makes
 * revocation bite in seconds without polling or push (Arch §07).
 */

const TOKEN_VERSION = "v1";
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  /** person id */
  sub: string;
  /** society scope — every query is scoped by this, never by client input */
  soc: string;
  role: string;
  /** membership version at mint time */
  mv: number;
  /** install id, recorded on entries; never shown to users (D-004) */
  iid: string;
  /** expiry, epoch ms */
  exp: number;
}

export class TokenError extends Error {}

function signingKey(): Buffer {
  const key = process.env["JWT_SIGNING_KEY"];
  if (!key || key.length < 32) {
    throw new TokenError(
      "JWT_SIGNING_KEY is missing or shorter than 32 characters. Render generates this " +
        "automatically (generateValue: true); set it locally in .env",
    );
  }
  return Buffer.from(key, "utf8");
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mac(payload: string): Buffer {
  return createHmac("sha256", signingKey()).update(payload, "utf8").digest();
}

export function signAccessToken(
  claims: Omit<AccessClaims, "exp">,
  now: number = Date.now(),
): string {
  const full: AccessClaims = { ...claims, exp: now + ACCESS_TOKEN_TTL_MS };
  const payload = `${TOKEN_VERSION}.${b64url(JSON.stringify(full))}`;
  return `${payload}.${b64url(mac(payload))}`;
}

export function verifyAccessToken(token: string, now: number = Date.now()): AccessClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("malformed token");

  const [version, body, signature] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) throw new TokenError("unsupported token version");

  const expected = mac(`${version}.${body}`);
  const provided = Buffer.from(signature, "base64url");

  // Length check first: timingSafeEqual throws on mismatched lengths, and that
  // throw would itself leak length information through the error path.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new TokenError("bad signature");
  }

  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AccessClaims;
  } catch {
    throw new TokenError("unreadable claims");
  }

  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new TokenError("token expired");
  }
  for (const field of ["sub", "soc", "role", "iid"] as const) {
    if (typeof claims[field] !== "string" || claims[field].length === 0) {
      throw new TokenError(`token missing ${field}`);
    }
  }
  if (typeof claims.mv !== "number") throw new TokenError("token missing mv");

  return claims;
}

/**
 * Refresh tokens are opaque random strings. Only their hash is stored, so a
 * leaked database does not yield usable sessions.
 */
export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): Buffer {
  return createHmac("sha256", signingKey()).update(`refresh:${token}`, "utf8").digest();
}
