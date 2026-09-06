// Cryptographically secure randomness.
//
// Under Metro this resolves to expo-crypto's native CSPRNG. The module is
// pulled in through a guarded require rather than a static import so the rest
// of the crypto stack stays loadable (and therefore unit-testable) outside of
// React Native, where `globalThis.crypto.getRandomValues` is used instead.
const nodeStyleRequire = typeof require === 'function' ? require : null;

let expoGetRandomBytes;
function resolveExpo() {
  if (expoGetRandomBytes !== undefined) return expoGetRandomBytes;
  expoGetRandomBytes = null;
  if (nodeStyleRequire) {
    try {
      const mod = nodeStyleRequire('expo-crypto');
      if (mod && typeof mod.getRandomBytes === 'function') expoGetRandomBytes = mod.getRandomBytes;
    } catch (err) {
      // Not running inside Expo; fall through to the WebCrypto path.
    }
  }
  return expoGetRandomBytes;
}

export function randomBytes(length) {
  const fromExpo = resolveExpo();
  if (fromExpo) return new Uint8Array(fromExpo(length));

  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    return webcrypto.getRandomValues(new Uint8Array(length));
  }
  throw new Error('No cryptographically secure random source is available');
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

export function randomHex(byteLength) {
  const bytes = randomBytes(byteLength);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}

/** Random RFC 4122 v4 UUID, used for local account ids. */
export function randomUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = randomHexFrom(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomHexFrom(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return out;
}
