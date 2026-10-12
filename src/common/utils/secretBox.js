import crypto from 'node:crypto';
import env from '../../config/env.js';

// Purpose-bound keys derived from the server secret (HKDF), so one leaked derived key can't be reused elsewhere.
const keys = new Map();
export function derivedKey(purpose, length = 32) {
  if (!keys.has(purpose)) keys.set(purpose, Buffer.from(crypto.hkdfSync('sha256', env.JWT_ACCESS_SECRET, 'colonyhub', purpose, length)));
  return keys.get(purpose);
}

// AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url). The purpose is bound as AAD.
export function seal(plain, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(`seal:${purpose}`), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed, purpose) {
  const [v, iv, tag, ct] = String(sealed).split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported sealed value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(`seal:${purpose}`), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

// Keyed hash for low-entropy secrets (backup codes): a database leak alone can't brute-force them.
export const keyedHash = (value, purpose) => crypto.createHmac('sha256', derivedKey(`hash:${purpose}`)).update(String(value)).digest('hex');
