import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import {
  parseMaFileText, normaliseMaFile, accountToMaFile, serialiseMaFile,
  encryptExport, decryptExport, inspectExport, decryptSdaMaFile,
  parseJsonPreservingSteamIds, looksLikeSdaEncrypted, MaFileError,
} from '../src/steam/maFile.js';

// Kept as raw text on purpose: writing 76561198234567891 as a JS number literal
// rounds it to ...890 before it is ever serialised, which is precisely the
// hazard parseJsonPreservingSteamIds exists to defend against.
const SDA_MAFILE = `{
  "shared_secret": "BGhtL4KLGRUtV1sNRPRVQfLBnQE=",
  "serial_number": "1234567890123456789",
  "revocation_code": "R12345",
  "uri": "otpauth://totp/Steam:tester?secret=AQ2G2XCLBUNBKNKXFVMY&issuer=Steam",
  "server_time": 1700000000,
  "account_name": "tester",
  "token_gid": "abcdef123456",
  "identity_secret": "Yf0aP3nDh0y8mQ2iWzKrLzXbVvM=",
  "secret_1": "kL9mNvQr2sTuVwXyZ0aBcDeFgHi=",
  "status": 1,
  "device_id": "android:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "fully_enrolled": true,
  "Session": { "SessionID": "abc", "SteamID": 76561198234567891 }
}`;

const parsedFixture = () => parseJsonPreservingSteamIds(SDA_MAFILE);

test('parses a real-shaped SDA maFile', () => {
  const account = parseMaFileText(SDA_MAFILE);
  assert.equal(account.accountName, 'tester');
  assert.equal(account.steamId, '76561198234567891');
  assert.equal(account.sharedSecret, 'BGhtL4KLGRUtV1sNRPRVQfLBnQE=');
  assert.equal(account.identitySecret, 'Yf0aP3nDh0y8mQ2iWzKrLzXbVvM=');
  assert.equal(account.revocationCode, 'R12345');
  assert.equal(account.password, null);
});

test('17-digit SteamIDs survive parsing (JSON.parse alone corrupts them)', () => {
  const raw = '{"Session":{"SteamID":76561198234567891}}';
  // Demonstrate the hazard this guards against.
  assert.notEqual(String(JSON.parse(raw).Session.SteamID), '76561198234567891');
  assert.equal(parseJsonPreservingSteamIds(raw).Session.SteamID, '76561198234567891');
});

test('a maFile with no shared_secret is rejected, not silently accepted', () => {
  assert.throws(() => parseMaFileText('{"account_name":"x"}'), (e) => e.code === 'NO_SHARED_SECRET');
});

test('non-JSON input gives a clear error', () => {
  assert.throws(() => parseMaFileText('not json at all {{{'), /not valid JSON/);
});

test('base64 blob is recognised as SDA-encrypted and explained', () => {
  const blob = nodeCrypto.randomBytes(200).toString('base64');
  assert.ok(looksLikeSdaEncrypted(blob));
  assert.throws(() => parseMaFileText(blob), (e) => e.code === 'SDA_ENCRYPTED');
});

test('maFile round-trips through serialise/parse with SteamID unquoted', () => {
  const account = parseMaFileText(SDA_MAFILE);
  account.password = 'sup3r-s3cret';
  const text = serialiseMaFile(accountToMaFile(account));

  assert.match(text, /"SteamID": 76561198234567891/, 'SteamID must stay an unquoted integer for SDA');
  assert.match(text, /"password": "sup3r-s3cret"/);

  const back = parseMaFileText(text);
  assert.equal(back.steamId, '76561198234567891');
  assert.equal(back.password, 'sup3r-s3cret');
  assert.equal(back.sharedSecret, account.sharedSecret);
});

test('password can be excluded from an export', () => {
  const account = parseMaFileText(SDA_MAFILE);
  account.password = 'sup3r-s3cret';
  const text = serialiseMaFile(accountToMaFile(account, { includePassword: false }));
  assert.doesNotMatch(text, /sup3r-s3cret/);
});

test('encrypted export round-trips, passwords included', () => {
  const a = parseMaFileText(SDA_MAFILE);
  a.password = 'pw-one';
  const b = normaliseMaFile({ ...parsedFixture(), account_name: 'second', password: 'pw-two' });

  const bundle = encryptExport([a, b], 'master-passphrase', { iterations: 1000 });
  assert.doesNotMatch(bundle, /pw-one/, 'ciphertext must not leak plaintext');
  assert.doesNotMatch(bundle, /BGhtL4KLGRUtV1sNRPRVQfLBnQE=/, 'shared_secret must not leak');

  const info = inspectExport(bundle);
  assert.deepEqual({ encrypted: info.encrypted, accountCount: info.accountCount, containsPasswords: info.containsPasswords },
    { encrypted: true, accountCount: 2, containsPasswords: true });

  const restored = decryptExport(bundle, 'master-passphrase');
  assert.equal(restored.length, 2);
  assert.equal(restored[0].accountName, 'tester');
  assert.equal(restored[0].password, 'pw-one');
  assert.equal(restored[0].steamId, '76561198234567891');
  assert.equal(restored[1].password, 'pw-two');
});

test('wrong export password is reported, never decrypted to garbage', () => {
  const bundle = encryptExport([parseMaFileText(SDA_MAFILE)], 'right', { iterations: 1000 });
  assert.throws(() => decryptExport(bundle, 'wrong'), (e) => e.code === 'BAD_PASSWORD');
});

test('tampered ciphertext is caught by the MAC', () => {
  const bundle = JSON.parse(encryptExport([parseMaFileText(SDA_MAFILE)], 'pw', { iterations: 1000 }));
  const bytes = Buffer.from(bundle.data, 'base64');
  bytes[5] ^= 0x01;
  bundle.data = bytes.toString('base64');
  assert.throws(() => decryptExport(JSON.stringify(bundle), 'pw'), (e) => e.code === 'BAD_PASSWORD');
});

test('export omitting passwords truly omits them', () => {
  const a = parseMaFileText(SDA_MAFILE);
  a.password = 'pw-one';
  const bundle = encryptExport([a], 'pw', { includePasswords: false, iterations: 1000 });
  assert.equal(inspectExport(bundle).containsPasswords, false);
  assert.equal(decryptExport(bundle, 'pw')[0].password, null);
});

test('reads a maFile encrypted the way SDA encrypts it', () => {
  // Produce ciphertext with node using SDA's parameters, then read it back.
  const passkey = 'sda-password';
  const salt = nodeCrypto.randomBytes(8);
  const iv = nodeCrypto.randomBytes(16);
  const key = nodeCrypto.pbkdf2Sync(passkey, salt, 50000, 32, 'sha1');
  const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(SDA_MAFILE, 'utf8'), cipher.final()]).toString('base64');

  const text = decryptSdaMaFile(ct, passkey, salt.toString('base64'), iv.toString('base64'));
  assert.equal(parseMaFileText(text).accountName, 'tester');
  assert.throws(() => decryptSdaMaFile(ct, 'nope', salt.toString('base64'), iv.toString('base64')),
    (e) => e.code === 'BAD_PASSWORD');
});

test('automation settings survive a round trip and are clamped', () => {
  const account = normaliseMaFile({
    ...parsedFixture(),
    automation: { enabled: true, intervalSeconds: 5, confirmTrades: true, trustedSteamIds: ['76561198234567891', 'junk'] },
  });
  assert.equal(account.automation.enabled, true);
  assert.equal(account.automation.intervalSeconds, 30, 'interval must be clamped to a sane floor');
  assert.deepEqual(account.automation.trustedSteamIds, ['76561198234567891'], 'invalid steamids dropped');

  const back = parseMaFileText(serialiseMaFile(accountToMaFile(account)));
  assert.equal(back.automation.confirmTrades, true);
});
