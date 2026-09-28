import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { normaliseMaFile, parseMaFileText, accountCapabilities, accountToMaFile, serialiseMaFile } from '../src/steam/maFile.js';
import { login, GuardType } from '../src/steam/session.js';
import { _setTimeOffset } from '../src/steam/time.js';
import { bytesToHex } from '../src/lib/bytes.js';

_setTimeOffset(0);

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const MOD = bytesToHex(new Uint8Array(Buffer.from(jwk.n, 'base64url')));
const EXP = bytesToHex(new Uint8Array(Buffer.from(jwk.e, 'base64url')));

function jwt(exp) {
  return `a.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.b`;
}

function mockSteam(guardTypes) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = Object.fromEntries(new URLSearchParams(options.body || ''));
    calls.push({ url, body });
    let payload = { response: {} };
    if (url.includes('GetPasswordRSAPublicKey')) {
      payload = { response: { publickey_mod: MOD, publickey_exp: EXP, timestamp: '1' } };
    } else if (url.includes('BeginAuthSessionViaCredentials')) {
      payload = { response: {
        client_id: 'C', request_id: 'UklE', steamid: '76561198234567891', interval: 1,
        allowed_confirmations: guardTypes.map((t) => ({ confirmation_type: t })),
      } };
    } else if (url.includes('PollAuthSessionStatus')) {
      payload = { response: { refresh_token: 'R', access_token: jwt(2000000000), account_name: 'plain' } };
    } else if (url.includes('QueryTime')) {
      payload = { response: { server_time: String(Math.floor(Date.now() / 1000)) } };
    }
    return {
      ok: true, status: 200,
      headers: { get: (n) => (n.toLowerCase() === 'x-eresult' ? '1' : null) },
      text: async () => JSON.stringify(payload),
    };
  };
  return calls;
}

test('a maFile without shared_secret is still rejected - that file is broken', () => {
  assert.throws(() => parseMaFileText('{"account_name":"x"}'), (e) => e.code === 'NO_SHARED_SECRET');
});

test('an account added by hand may have no authenticator', () => {
  const account = normaliseMaFile(
    { account_name: 'plain', steamid: '76561198234567891' },
    { requireSharedSecret: false }
  );
  assert.equal(account.accountName, 'plain');
  assert.equal(account.sharedSecret, '');
  assert.equal(account.identitySecret, '');
  assert.equal(account.steamId, '76561198234567891');
});

test('an account with no authenticator and no name is still rejected', () => {
  assert.throws(() => normaliseMaFile({ steamid: '76561198234567891' }, { requireSharedSecret: false }),
    (e) => e.code === 'NO_ACCOUNT_NAME');
});

test('capabilities describe exactly what such an account can do', () => {
  const plain = normaliseMaFile({ account_name: 'plain' }, { requireSharedSecret: false });
  const caps = accountCapabilities(plain);
  assert.equal(caps.hasAuthenticator, false);
  assert.equal(caps.canGenerateCodes, false);
  assert.equal(caps.canConfirm, false);
  assert.equal(caps.canListOnMarket, false, 'a market listing always needs a confirmation');
  // The useful half still works.
  assert.equal(caps.canBrowseInventory, true);
  assert.equal(caps.canReadTrades, true);
  assert.equal(caps.canRespondToTrades, true);
  assert.equal(caps.canSendTrades, true);
});

test('an authenticator with no identity_secret can still trade but not confirm', () => {
  const caps = accountCapabilities({ sharedSecret: 'abc=', identitySecret: '' });
  assert.equal(caps.canGenerateCodes, true);
  assert.equal(caps.canConfirm, false);
  assert.equal(caps.canListOnMarket, false);
});

test('an authenticator-less account survives a vault round trip', () => {
  const plain = normaliseMaFile({ account_name: 'plain', steamid: '76561198234567891', password: 'pw' },
    { requireSharedSecret: false });
  const text = serialiseMaFile(accountToMaFile(plain));
  const back = normaliseMaFile(JSON.parse(text), { requireSharedSecret: false });
  assert.equal(back.accountName, 'plain');
  assert.equal(back.password, 'pw');
  assert.equal(back.sharedSecret, '');
});

test('an account with no Steam Guard at all signs in with no code', async () => {
  const calls = mockSteam([GuardType.None]);
  const result = await login({ accountName: 'plain', password: 'pw' });
  assert.equal(result.steamId, '76561198234567891');
  assert.ok(!calls.some((c) => c.url.includes('UpdateAuthSessionWithSteamGuardCode')),
    'no Guard code should be submitted when Steam asks for none');
});

test('an email-code account signs in using the code the user types', async () => {
  const calls = mockSteam([GuardType.EmailCode]);
  let asked = null;
  const result = await login({
    accountName: 'plain',
    password: 'pw',
    onGuardRequired: async (request) => {
      asked = request;
      return 'K7T2M';
    },
  });
  assert.equal(result.steamId, '76561198234567891');
  assert.equal(asked.type, GuardType.EmailCode, 'the prompt must say which kind of code is wanted');

  const submitted = calls.find((c) => c.url.includes('UpdateAuthSessionWithSteamGuardCode'));
  assert.equal(submitted.body.code, 'K7T2M');
  assert.equal(submitted.body.code_type, String(GuardType.EmailCode));
});

test('the password still travels encrypted for an account with no authenticator', async () => {
  const calls = mockSteam([GuardType.None]);
  await login({ accountName: 'plain', password: 'hunter2' });
  const begin = calls.find((c) => c.url.includes('BeginAuthSessionViaCredentials'));
  assert.doesNotMatch(JSON.stringify(begin.body), /hunter2/);
  const decrypted = nodeCrypto.privateDecrypt(
    { key: privateKey, padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(begin.body.encrypted_password, 'base64')
  );
  assert.equal(decrypted.toString('utf8'), 'hunter2');
});

test('without a prompt, an email-code account fails clearly instead of hanging', async () => {
  mockSteam([GuardType.EmailCode]);
  // This is the automation path: nobody is there to read the email.
  await assert.rejects(() => login({ accountName: 'plain', password: 'pw' }),
    (err) => err.code === 'GUARD_REQUIRED' && /emailed to you/.test(err.message));
});

test('a cancelled prompt fails clearly rather than submitting an empty code', async () => {
  const calls = mockSteam([GuardType.EmailCode]);
  await assert.rejects(
    () => login({ accountName: 'plain', password: 'pw', onGuardRequired: async () => null }),
    (err) => err.code === 'GUARD_REQUIRED'
  );
  assert.ok(!calls.some((c) => c.url.includes('UpdateAuthSessionWithSteamGuardCode')));
});
