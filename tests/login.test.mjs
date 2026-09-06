import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { login, renewAccessToken, needsRenewal, decodeJwtExpiry, GuardType } from '../src/steam/session.js';
import { generateAuthCode } from '../src/steam/guard.js';
import { _setTimeOffset } from '../src/steam/time.js';
import { bytesToHex } from '../src/lib/bytes.js';

_setTimeOffset(0);

const SHARED_SECRET = nodeCrypto.randomBytes(20).toString('base64');
const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const MOD_HEX = bytesToHex(new Uint8Array(Buffer.from(jwk.n, 'base64url')));
const EXP_HEX = bytesToHex(new Uint8Array(Buffer.from(jwk.e, 'base64url')));

function jwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.signature`;
}

/** Route mocked responses by URL fragment and record every request. */
function mockSteam(handlers) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : {};
    const query = Object.fromEntries(new URL(url).searchParams);
    calls.push({ url, body, query });

    const key = Object.keys(handlers).find((fragment) => url.includes(fragment));
    if (!key) throw new Error(`Unmocked request: ${url}`);
    const result = handlers[key]({ body, query, calls });

    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'x-eresult' ? result.eresult ?? '1' : null) },
      text: async () => JSON.stringify(result.body ?? result),
    };
  };
  return calls;
}

test('login encrypts the password with Steam\'s key and submits the Guard code itself', async () => {
  let pollCount = 0;
  const calls = mockSteam({
    'GetPasswordRSAPublicKey': () => ({
      body: { response: { publickey_mod: MOD_HEX, publickey_exp: EXP_HEX, timestamp: '99' } },
    }),
    'BeginAuthSessionViaCredentials': () => ({
      body: { response: {
        client_id: 'CID', request_id: 'UklE', steamid: '76561198234567891', interval: 1,
        allowed_confirmations: [{ confirmation_type: GuardType.DeviceCode }],
      } },
    }),
    'UpdateAuthSessionWithSteamGuardCode': () => ({ body: { response: {} } }),
    'PollAuthSessionStatus': () => {
      pollCount += 1;
      return { body: { response: {
        refresh_token: 'REFRESH', access_token: jwt(2000000000), account_name: 'tester',
      } } };
    },
    'QueryTime': () => ({ body: { response: { server_time: String(Math.floor(Date.now() / 1000)) } } }),
  });

  const result = await login({ accountName: 'tester', password: 'hunter2', sharedSecret: SHARED_SECRET });

  assert.equal(result.steamId, '76561198234567891');
  assert.equal(result.refreshToken, 'REFRESH');
  assert.equal(result.accessTokenExpires, 2000000000);
  assert.match(result.sessionId, /^[0-9a-f]{24}$/);
  assert.equal(pollCount, 1);

  // The password must reach Steam RSA-encrypted, never in the clear.
  const begin = calls.find((call) => call.url.includes('BeginAuthSessionViaCredentials'));
  assert.ok(begin.body.encrypted_password);
  assert.doesNotMatch(JSON.stringify(begin.body), /hunter2/);
  const decrypted = nodeCrypto.privateDecrypt(
    { key: privateKey, padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(begin.body.encrypted_password, 'base64')
  );
  assert.equal(decrypted.toString('utf8'), 'hunter2');
  assert.equal(begin.body.website_id, 'Community');

  // The Guard code must be the real TOTP for this secret, submitted as a device code.
  const guard = calls.find((call) => call.url.includes('UpdateAuthSessionWithSteamGuardCode'));
  assert.equal(guard.body.code_type, String(GuardType.DeviceCode));
  assert.equal(guard.body.code, generateAuthCode(SHARED_SECRET, Math.floor(Date.now() / 1000)));
});

test('a wrong password is reported instead of hanging on the poll', async () => {
  mockSteam({
    'GetPasswordRSAPublicKey': () => ({ body: { response: { publickey_mod: MOD_HEX, publickey_exp: EXP_HEX, timestamp: '1' } } }),
    'BeginAuthSessionViaCredentials': () => ({ eresult: '5', body: { response: {} } }),
    'QueryTime': () => ({ body: { response: { server_time: String(Math.floor(Date.now() / 1000)) } } }),
  });
  await assert.rejects(
    () => login({ accountName: 'tester', password: 'wrong', sharedSecret: SHARED_SECRET }),
    /rejected the account name or password/
  );
});

test('an account needing a Guard code with no stored secret says so', async () => {
  mockSteam({
    'GetPasswordRSAPublicKey': () => ({ body: { response: { publickey_mod: MOD_HEX, publickey_exp: EXP_HEX, timestamp: '1' } } }),
    'BeginAuthSessionViaCredentials': () => ({ body: { response: {
      client_id: 'CID', request_id: 'UklE', steamid: '765611982345678910',
      allowed_confirmations: [{ confirmation_type: GuardType.DeviceCode }],
    } } }),
    'QueryTime': () => ({ body: { response: { server_time: String(Math.floor(Date.now() / 1000)) } } }),
  });
  await assert.rejects(
    () => login({ accountName: 'tester', password: 'pw' }),
    (err) => err.code === 'GUARD_REQUIRED'
  );
});

test('an account requiring in-app approval is explained, not retried blindly', async () => {
  mockSteam({
    'GetPasswordRSAPublicKey': () => ({ body: { response: { publickey_mod: MOD_HEX, publickey_exp: EXP_HEX, timestamp: '1' } } }),
    'BeginAuthSessionViaCredentials': () => ({ body: { response: {
      client_id: 'CID', request_id: 'UklE', steamid: '76561198234567891',
      allowed_confirmations: [{ confirmation_type: GuardType.DeviceConfirmation }],
    } } }),
    'QueryTime': () => ({ body: { response: { server_time: String(Math.floor(Date.now() / 1000)) } } }),
  });
  await assert.rejects(
    () => login({ accountName: 'tester', password: 'pw' }),
    (err) => err.code === 'APPROVAL_REQUIRED'
  );
});

test('access tokens renew from the refresh token', async () => {
  const calls = mockSteam({
    'GenerateAccessTokenForApp': () => ({ body: { response: { access_token: jwt(1900000000) } } }),
  });
  const renewed = await renewAccessToken({ steamId: '76561198234567891', refreshToken: 'REFRESH' });
  assert.equal(renewed.accessTokenExpires, 1900000000);
  assert.equal(calls[0].body.refresh_token, 'REFRESH');
});

test('renewal without a refresh token fails fast', async () => {
  await assert.rejects(() => renewAccessToken({ steamId: '1' }), (err) => err.code === 'NO_REFRESH_TOKEN');
});

test('token expiry is read from the JWT and drives renewal', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(decodeJwtExpiry(jwt(1234567890)), 1234567890);
  assert.equal(decodeJwtExpiry('not-a-jwt'), 0);

  assert.equal(needsRenewal({ accessToken: null }), true, 'no token means renew');
  assert.equal(needsRenewal({ accessToken: 'x', accessTokenExpires: now + 3600 }), false);
  assert.equal(needsRenewal({ accessToken: 'x', accessTokenExpires: now + 60 }), true,
    'renew before it actually expires, not after');
});
