// Steam Guard: TOTP code generation and mobile-confirmation request signing.
import { base64ToBytes, bytesToBase64, uint64BE, utf8ToBytes, concatBytes } from '../lib/bytes.js';
import { hmacSha1, sha1Hex } from '../lib/crypto.js';

/** Steam's alphabet for the 5-character Guard code. */
const CODE_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
export const CODE_PERIOD_SECONDS = 30;

/**
 * Steam Guard TOTP. Same construction as RFC 6238 but with a 26-symbol
 * alphabet instead of decimal digits, and a fixed 30 second period.
 *
 * @param {string} sharedSecret base64 shared_secret from the maFile
 * @param {number} timeSeconds  unix time already corrected for clock drift
 */
export function generateAuthCode(sharedSecret, timeSeconds) {
  const key = base64ToBytes(sharedSecret);
  if (key.length === 0) throw new Error('shared_secret is empty or not valid base64');

  const counter = Math.floor(timeSeconds / CODE_PERIOD_SECONDS);
  const mac = hmacSha1(key, uint64BE(counter));

  // Dynamic truncation (RFC 4226 section 5.3).
  const offset = mac[19] & 0x0f;
  let value =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);

  let code = '';
  for (let i = 0; i < 5; i++) {
    code += CODE_ALPHABET[value % CODE_ALPHABET.length];
    value = Math.floor(value / CODE_ALPHABET.length);
  }
  return code;
}

/** Seconds remaining until the current code rotates. */
export function secondsUntilRotation(timeSeconds) {
  return CODE_PERIOD_SECONDS - (Math.floor(timeSeconds) % CODE_PERIOD_SECONDS);
}

/**
 * Signature for a /mobileconf/ request.
 *
 * @param {string} identitySecret base64 identity_secret from the maFile
 * @param {'conf'|'details'|'allow'|'cancel'} tag
 * @param {number} timeSeconds
 * @returns {string} base64 confirmation key
 */
export function getConfirmationKey(identitySecret, tag, timeSeconds) {
  const key = base64ToBytes(identitySecret);
  if (key.length === 0) throw new Error('identity_secret is empty or not valid base64');
  const message = concatBytes(uint64BE(Math.floor(timeSeconds)), utf8ToBytes(tag));
  return bytesToBase64(hmacSha1(key, message));
}

/**
 * Device id in the format SDA and the Steam mobile app use:
 * "android:" followed by a UUID-shaped rendering of SHA1(steamid).
 */
export function getDeviceId(steamId) {
  const hash = sha1Hex(String(steamId));
  return (
    'android:' +
    [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)]
      .join('-')
  );
}
