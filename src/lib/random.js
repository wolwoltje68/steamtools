// Cryptographically secure randomness.
//
// The require below is deliberately a literal call inside a try/catch rather
// than a static import or an aliased reference:
//
//   * Metro only collects dependencies from literal `require('...')` calls, so
//     aliasing it (`const r = require; r('expo-crypto')`) silently drops the
//     module from the bundle and leaves this file with no RNG on a device.
//   * A static `import` would make the whole crypto stack unloadable outside
//     React Native, where `require` is undefined and the catch below falls
//     through to WebCrypto instead. That keeps the primitives unit-testable.
let expoCrypto = null;
try {
  // eslint-disable-next-line no-undef
  expoCrypto = require('expo-crypto');
} catch (err) {
  expoCrypto = null; // Not running under Metro.
}

function platformRandomBytes(length) {
  if (expoCrypto && typeof expoCrypto.getRandomBytes === 'function') {
    return new Uint8Array(expoCrypto.getRandomBytes(length));
  }
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    return webcrypto.getRandomValues(new Uint8Array(length));
  }
  // Never silently downgrade to Math.random: every caller here is protecting a
  // Steam account.
  throw new Error('No cryptographically secure random source is available');
}

export function randomBytes(length) {
  return platformRandomBytes(length);
}

/** PKCS#1 v1.5 padding requires a random block containing no zero bytes. */
export function randomBytesNonZero(length) {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const candidates = randomBytes(length - filled + 16);
    for (let i = 0; i < candidates.length && filled < length; i++) {
      if (candidates[i] !== 0) out[filled++] = candidates[i];
    }
  }
  return out;
}

const HEX = '0123456789abcdef';

function toHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

export function randomHex(byteLength) {
  return toHex(randomBytes(byteLength));
}

/** Random RFC 4122 v4 UUID, used for local account ids. */
export function randomUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True when a real CSPRNG is available; surfaced for diagnostics. */
export function hasSecureRandom() {
  try {
    randomBytes(1);
    return true;
  } catch (err) {
    return false;
  }
}
