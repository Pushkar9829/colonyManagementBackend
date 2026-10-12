import crypto from 'node:crypto';

// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) — what Google Authenticator, Authy, Microsoft Authenticator use.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1.
export const generateSecret = () => base32Encode(crypto.randomBytes(20));

// RFC 4226 HOTP. `key` is the raw secret (Buffer); counter is the moving factor.
export function hotp(key, counter, { digits = DIGITS, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (timeMs = Date.now()) => Math.floor(timeMs / 1000 / STEP_SECONDS);

export const totp = (secretBase32, timeMs = Date.now(), opts) => hotp(base32Decode(secretBase32), stepAt(timeMs), opts);

// Returns the matching time step (so callers can block replays) or null. window = steps of clock drift allowed each way.
export function verifyTotp(secretBase32, code, { timeMs = Date.now(), window = 1 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const key = base32Decode(secretBase32);
  const now = stepAt(timeMs);
  const given = Buffer.from(String(code));
  for (let d = -window; d <= window; d += 1) {
    const step = now + d;
    if (step < 0) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), given)) return step;
  }
  return null;
}

export function otpauthUri({ secret, account, issuer }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
