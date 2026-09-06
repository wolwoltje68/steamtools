import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { generateAuthCode, getConfirmationKey, getDeviceId, secondsUntilRotation } from '../src/steam/guard.js';

// Reference implementation transcribed independently from the SDA algorithm.
function referenceCode(sharedSecretB64, time) {
  const key = Buffer.from(sharedSecretB64, 'base64');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(time / 30)));
  const mac = nodeCrypto.createHmac('sha1', key).update(buf).digest();
  const start = mac[19] & 0x0f;
  let full = mac.readUInt32BE(start) & 0x7fffffff;
  const chars = '23456789BCDFGHJKMNPQRTVWXY';
  let out = '';
  for (let i = 0; i < 5; i++) { out += chars[full % 26]; full = Math.floor(full / 26); }
  return out;
}

test('auth code matches the reference algorithm across many time slots', () => {
  const secret = nodeCrypto.randomBytes(20).toString('base64');
  for (let i = 0; i < 500; i++) {
    const t = 1600000000 + i * 37;
    assert.equal(generateAuthCode(secret, t), referenceCode(secret, t));
  }
});

test('auth code is a stable 5-char code within one 30s window', () => {
  const secret = nodeCrypto.randomBytes(20).toString('base64');
  const base = 1700000000 - (1700000000 % 30);
  const first = generateAuthCode(secret, base);
  assert.match(first, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
  assert.equal(generateAuthCode(secret, base + 29), first);
  assert.notEqual(generateAuthCode(secret, base + 30), first);
});

test('confirmation key matches hmac-sha1 over time||tag', () => {
  const secret = nodeCrypto.randomBytes(20).toString('base64');
  const time = 1712345678;
  for (const tag of ['conf', 'details', 'allow', 'cancel']) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(time));
    const expected = nodeCrypto.createHmac('sha1', Buffer.from(secret, 'base64'))
      .update(Buffer.concat([buf, Buffer.from(tag, 'utf8')])).digest('base64');
    assert.equal(getConfirmationKey(secret, tag, time), expected);
  }
});

test('device id has the android UUID shape SDA produces', () => {
  const id = getDeviceId('76561198000000000');
  assert.match(id, /^android:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(id, getDeviceId(76561198000000000n.toString()));
});

test('rotation countdown', () => {
  assert.equal(secondsUntilRotation(1700000000 - (1700000000 % 30)), 30);
  assert.equal(secondsUntilRotation(1700000000 - (1700000000 % 30) + 29), 1);
});

test('empty secret is rejected rather than producing a bogus code', () => {
  assert.throws(() => generateAuthCode('', 1700000000), /shared_secret/);
});
