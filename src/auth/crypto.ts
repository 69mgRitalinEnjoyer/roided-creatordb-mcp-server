/**
 * Token sealing, adapted from the official CreatorDB MCP server (functions/src/crypto.ts,
 * MIT License, Copyright (c) 2026 CreatorDB).
 *
 * A sealed value is an AES-256-GCM-encrypted JSON blob. Opening it with the wrong secret, or
 * after it was tampered with, fails the GCM check. An `exp` field in the payload is enforced.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function keyFromSecret(secret: string, purpose: string): Buffer {
  // A separate key per purpose, so a sealed sign-in code can never be read as a stored API key.
  return createHash('sha256').update(`${purpose}\n${secret}`).digest();
}

export function seal(secret: string, purpose: string, payload: Record<string, unknown>): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, keyFromSecret(secret, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function open<T extends Record<string, unknown>>(secret: string, purpose: string, token: string): T {
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < IV_LEN + TAG_LEN) throw new Error('token too short');
  const decipher = createDecipheriv(ALG, keyFromSecret(secret, purpose), raw.subarray(0, IV_LEN));
  decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8')) as T & { exp?: number };
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) throw new Error('token expired');
  return payload;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
