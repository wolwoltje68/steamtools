// Public-key-only RSA with PKCS#1 v1.5 padding, used to encrypt the Steam
// password for BeginAuthSessionViaCredentials. Hermes ships BigInt, so modular
// exponentiation needs no native module.
import { bytesToHex, hexToBytes } from './bytes.js';
import { randomBytesNonZero } from './random.js';

function modPow(base, exponent, modulus) {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * @param {string} modulusHex   publickey_mod from GetPasswordRSAPublicKey
 * @param {string} exponentHex  publickey_exp (normally "010001")
 * @param {Uint8Array} message  plaintext, at most modulusLength - 11 bytes
 * @param {(n: number) => Uint8Array} [padder] injectable for deterministic tests
 * @returns {Uint8Array} ciphertext, exactly modulusLength bytes
 */
export function rsaEncryptPkcs1(modulusHex, exponentHex, message, padder = randomBytesNonZero) {
  const modulusBytes = hexToBytes(modulusHex);
  const k = modulusBytes.length;
  if (message.length > k - 11) throw new Error('Message too long for this RSA modulus');

  // EM = 0x00 || 0x02 || PS (non-zero) || 0x00 || M
  const em = new Uint8Array(k);
  em[1] = 0x02;
  const psLength = k - message.length - 3;
  em.set(padder(psLength), 2);
  em[2 + psLength] = 0x00;
  em.set(message, k - message.length);

  const cipher = modPow(
    BigInt('0x' + bytesToHex(em)),
    BigInt('0x' + exponentHex),
    BigInt('0x' + bytesToHex(modulusBytes))
  );
  return hexToBytes(cipher.toString(16).padStart(k * 2, '0'));
}
