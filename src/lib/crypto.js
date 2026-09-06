// Hashing, MAC, key derivation and symmetric encryption.
//
// All pure JS (js-sha1 / js-sha256 / aes-js) so behaviour is identical under
// Hermes on Android and JSC on iOS, with no native build step required.
import sha1 from 'js-sha1';
import { sha256 } from 'js-sha256';
import aesjs from 'aes-js';

import { concatBytes, utf8ToBytes } from './bytes.js';

function asBytes(input) {
  if (typeof input === 'string') return utf8ToBytes(input);
  return input;
}

export function sha1Bytes(input) {
  return new Uint8Array(sha1.arrayBuffer(asBytes(input)));
}

export function sha1Hex(input) {
  return sha1.hex(asBytes(input));
}

export function hmacSha1(key, message) {
  return new Uint8Array(sha1.hmac.arrayBuffer(asBytes(key), asBytes(message)));
}

export function sha256Bytes(input) {
  return new Uint8Array(sha256.arrayBuffer(asBytes(input)));
}

export function hmacSha256(key, message) {
  return new Uint8Array(sha256.hmac.arrayBuffer(asBytes(key), asBytes(message)));
}

/**
 * PBKDF2-HMAC-SHA256. This runs on the JS thread, so the iteration count is a
 * deliberate trade-off between brute-force cost and unlock latency on a phone
 * (see VAULT_ITERATIONS in src/storage/vault.js).
 */
/**
 * PBKDF2 (RFC 2898) over an arbitrary HMAC. This runs on the JS thread, so the
 * iteration count is a deliberate trade-off between brute-force cost and unlock
 * latency on a phone (see VAULT_ITERATIONS in src/storage/vault.js).
 */
function pbkdf2(hmac, hashLength, password, salt, iterations, keyLength) {
  const passwordBytes = asBytes(password);
  const saltBytes = asBytes(salt);
  const blockCount = Math.ceil(keyLength / hashLength);
  const output = new Uint8Array(blockCount * hashLength);

  for (let block = 1; block <= blockCount; block++) {
    const counter = new Uint8Array([
      (block >>> 24) & 0xff,
      (block >>> 16) & 0xff,
      (block >>> 8) & 0xff,
      block & 0xff,
    ]);
    let u = hmac(passwordBytes, concatBytes(saltBytes, counter));
    const accumulated = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmac(passwordBytes, u);
      for (let j = 0; j < hashLength; j++) accumulated[j] ^= u[j];
    }
    output.set(accumulated, (block - 1) * hashLength);
  }
  return output.slice(0, keyLength);
}

export function pbkdf2Sha256(password, salt, iterations, keyLength) {
  return pbkdf2(hmacSha256, 32, password, salt, iterations, keyLength);
}

/** Only needed to read SteamDesktopAuthenticator's encrypted maFiles. */
export function pbkdf2Sha1(password, salt, iterations, keyLength) {
  return pbkdf2(hmacSha1, 20, password, salt, iterations, keyLength);
}

/**
 * Chunked, awaitable PBKDF2-SHA256.
 *
 * React Native runs JS on a single thread, so a 100k-iteration derivation would
 * freeze the interface for seconds. This yields back to the event loop every
 * few thousand iterations, which keeps the app responsive and lets the unlock
 * screen show real progress.
 *
 * @param {(fraction: number) => void} [onProgress] called with 0..1
 */
export async function pbkdf2Sha256Async(password, salt, iterations, keyLength, onProgress) {
  const passwordBytes = asBytes(password);
  const saltBytes = asBytes(salt);
  const blockCount = Math.ceil(keyLength / 32);
  const output = new Uint8Array(blockCount * 32);
  const totalIterations = blockCount * iterations;
  const CHUNK = 2000;
  let done = 0;

  for (let block = 1; block <= blockCount; block++) {
    const counter = new Uint8Array([
      (block >>> 24) & 0xff,
      (block >>> 16) & 0xff,
      (block >>> 8) & 0xff,
      block & 0xff,
    ]);
    let u = hmacSha256(passwordBytes, concatBytes(saltBytes, counter));
    const accumulated = u.slice();

    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(passwordBytes, u);
      for (let j = 0; j < 32; j++) accumulated[j] ^= u[j];
      done++;
      if (i % CHUNK === 0) {
        if (onProgress) onProgress(done / totalIterations);
        await yieldToEventLoop();
      }
    }
    output.set(accumulated, (block - 1) * 32);
  }
  if (onProgress) onProgress(1);
  return output.slice(0, keyLength);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function aesCbcEncrypt(key, iv, plaintext) {
  const cbc = new aesjs.ModeOfOperation.cbc(key, iv);
  return new Uint8Array(cbc.encrypt(aesjs.padding.pkcs7.pad(plaintext)));
}

export function aesCbcDecrypt(key, iv, ciphertext) {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('Ciphertext is not a whole number of AES blocks');
  }
  const cbc = new aesjs.ModeOfOperation.cbc(key, iv);
  const padded = new Uint8Array(cbc.decrypt(ciphertext));
  // Validate PKCS#7 explicitly: aes-js happily returns garbage otherwise.
  const pad = padded[padded.length - 1];
  if (pad < 1 || pad > 16 || pad > padded.length) throw new Error('Bad padding');
  for (let i = padded.length - pad; i < padded.length; i++) {
    if (padded[i] !== pad) throw new Error('Bad padding');
  }
  return padded.slice(0, padded.length - pad);
}
