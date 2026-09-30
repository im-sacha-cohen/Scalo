// Encryption of secrets stored in the database (third-party API keys): AES-256-GCM, random 96-bit IV per value,
// authenticated. The key is derived (HKDF-SHA256) from ENCRYPTION_KEY when set, otherwise from JWT_SECRET — changing
// that secret makes stored values unreadable (they must be entered again), it never exposes them.
//
// Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). `purpose` separates key spaces (one derived key per usage) and is
// authenticated, so a value encrypted for one usage cannot be decrypted as another.
import crypto from 'node:crypto';
import { env } from '../env';

const masterSecret = () => process.env.ENCRYPTION_KEY?.trim() || env.JWT_SECRET;

const keys = new Map<string, Buffer>();
function keyFor(purpose: string): Buffer {
  const id = `${purpose}\0${masterSecret()}`;
  let k = keys.get(id);
  if (!k) {
    k = Buffer.from(crypto.hkdfSync('sha256', masterSecret(), 'scalo-secretbox-v1', purpose, 32));
    keys.set(id, k);
  }
  return k;
}

export function encryptSecret(plain: string, purpose: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

/** Returns null when the value is malformed, was tampered with, or was encrypted with another key. */
export function decryptSecret(value: string, purpose: string): string | null {
  const [v, iv, tag, data] = value.split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
