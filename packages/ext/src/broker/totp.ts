/**
 * One-time codes for a vault login's TOTP secret (RFC 6238: HMAC-SHA1, a
 * 30-second step, 6 digits — what authenticator apps use), computed on the
 * server the moment a login fills. The secret is base32 as sites show it
 * (spaces and case ignored), or an `otpauth://` URI carrying `secret=`.
 */
import { createHmac } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const base32 = (text: string): Buffer | undefined => {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length === 0 ? undefined : Buffer.from(out);
};

const secretOf = (raw: string): string => {
  if (!raw.startsWith("otpauth://")) return raw;
  try {
    return new URL(raw).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
};

/** The current code, or undefined when the secret is not base32. */
export const totpCode = (
  raw: string,
  now: number = Date.now(),
  digits = 6,
  step = 30,
): string | undefined => {
  const key = base32(secretOf(raw.trim()));
  if (key === undefined) return undefined;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
};
