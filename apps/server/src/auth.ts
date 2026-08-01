import crypto from "node:crypto";
import { config } from "./config.js";

/**
 * Minimal stateless session tokens: `base64url(payload).base64url(hmac)`.
 * Signed with an HMAC secret so no server-side session store is needed. Tokens
 * carry only an expiry. No external JWT dependency.
 */
export function signToken(ttlHours = config.auth.tokenTtlHours): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlHours * 3600_000 })).toString(
    "base64url",
  );
  const sig = crypto.createHmac("sha256", config.auth.secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto
    .createHmac("sha256", config.auth.secret)
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp: number };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

/** Constant-time password check against DESK_PASSWORD. */
export function checkPassword(input: string): boolean {
  const expected = config.auth.password;
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header. */
export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : undefined;
}
