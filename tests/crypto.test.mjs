import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { utf8ToBytes, bytesToHex, hexToBytes, bytesToBase64, base64ToBytes } from '../src/lib/bytes.js';
import { hmacSha1, sha1Hex, sha256Bytes, hmacSha256, pbkdf2Sha256, aesCbcEncrypt, aesCbcDecrypt } from '../src/lib/crypto.js';
import { rsaEncryptPkcs1 } from '../src/lib/rsa.js';

test('sha1 / sha256 match node', () => {
  for (const msg of ['', 'abc', 'The quick brown fox jumps over the lazy dog']) {
    assert.equal(sha1Hex(msg), nodeCrypto.createHash('sha1').update(msg).digest('hex'));
    assert.equal(bytesToHex(sha256Bytes(msg)), nodeCrypto.createHash('sha256').update(msg).digest('hex'));
  }
});

test('hmac-sha1 / hmac-sha256 match node', () => {
  const key = nodeCrypto.randomBytes(20);
  const msg = nodeCrypto.randomBytes(100);
  assert.equal(bytesToHex(hmacSha1(new Uint8Array(key), new Uint8Array(msg))),
    nodeCrypto.createHmac('sha1', key).update(msg).digest('hex'));
  assert.equal(bytesToHex(hmacSha256(new Uint8Array(key), new Uint8Array(msg))),
    nodeCrypto.createHmac('sha256', key).update(msg).digest('hex'));
});

test('pbkdf2-sha256 matches node', () => {
  const salt = nodeCrypto.randomBytes(16);
  const derived = pbkdf2Sha256('correct horse battery staple', new Uint8Array(salt), 1000, 48);
  const expected = nodeCrypto.pbkdf2Sync('correct horse battery staple', salt, 1000, 48, 'sha256');
  assert.equal(bytesToHex(derived), expected.toString('hex'));
});

test('aes-256-cbc round-trips and matches node', () => {
  const key = nodeCrypto.randomBytes(32);
  const iv = nodeCrypto.randomBytes(16);
  const plaintext = utf8ToBytes('{"accounts":[{"account_name":"tester"}]} Ünïcødé 😀');

  const ours = aesCbcEncrypt(new Uint8Array(key), new Uint8Array(iv), plaintext);
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
  const theirs = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  assert.equal(bytesToHex(ours), theirs.toString('hex'));
  assert.equal(bytesToHex(aesCbcDecrypt(new Uint8Array(key), new Uint8Array(iv), ours)), bytesToHex(plaintext));
});

test('aes rejects tampered padding', () => {
  const key = nodeCrypto.randomBytes(32);
  const iv = nodeCrypto.randomBytes(16);
  const ct = aesCbcEncrypt(new Uint8Array(key), new Uint8Array(iv), utf8ToBytes('secret'));
  ct[0] ^= 0xff;
  assert.throws(() => aesCbcDecrypt(new Uint8Array(key), new Uint8Array(iv), ct));
});

test('rsa pkcs1 ciphertext decrypts with node private key', () => {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const modHex = bytesToHex(new Uint8Array(Buffer.from(jwk.n, 'base64url')));
  const expHex = bytesToHex(new Uint8Array(Buffer.from(jwk.e, 'base64url')));

  const password = 'hunter2-with-a-long-tail!';
  const ct = rsaEncryptPkcs1(modHex, expHex, utf8ToBytes(password));
  assert.equal(ct.length, 256);

  const decrypted = nodeCrypto.privateDecrypt(
    { key: privateKey, padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(ct)
  );
  assert.equal(decrypted.toString('utf8'), password);
});

test('base64 helpers agree with node', () => {
  for (let i = 0; i < 20; i++) {
    const raw = nodeCrypto.randomBytes(i * 3 + 1);
    const b64 = bytesToBase64(new Uint8Array(raw));
    assert.equal(b64, raw.toString('base64'));
    assert.equal(bytesToHex(base64ToBytes(b64)), raw.toString('hex'));
  }
});
