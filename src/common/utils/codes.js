import crypto from 'node:crypto';

const ALPHANUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

export function randomCode(length = 6, alphabet = ALPHANUM) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export const numericCode = (length = 6) => randomCode(length, '0123456789');

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
