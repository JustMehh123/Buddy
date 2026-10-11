import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Pairing codes and device tokens.
 *
 * A six-digit code proves the phone in your hand is talking to the computer in
 * front of you, not some other machine on the network. The token that follows
 * is a bearer credential stored in the phone's own keychain-backed storage.
 */

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const randomCode = (digits = 6): string => {
  let code = '';
  for (let i = 0; i < digits; i += 1) code += String(randomInt(0, 10));
  return code;
};

/** Constant-time compare that tolerates different lengths and non-strings. */
export const safeEqual = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Still do a comparison so the timing doesn't leak the length.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
};

/** Human-friendly code formatting for the computer's screen: 123 456. */
export const formatCode = (code: string): string => code.replace(/(\d{3})(\d{3})/, '$1 $2');

/** How long a pairing code stays valid. */
export const PAIRING_WINDOW_MS = 5 * 60 * 1000;
