import test from 'node:test';
import assert from 'node:assert/strict';

import { parseProfileInput, resolveProfile, resolveVanityName, ProfileError } from '../src/steam/profile.js';
import { appById, KNOWN_APPS, DEFAULT_CONTEXT_ID } from '../src/steam/inventory.js';

// The shape Steam actually returns for /id/<name>/?xml=1
const B4NNY_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile>
	<steamID64>76561197970825039</steamID64>
	<steamID><![CDATA[b4nny]]></steamID>
	<onlineState>online</onlineState>
	<avatarMedium><![CDATA[https://avatars.steamstatic.com/abc_medium.jpg]]></avatarMedium>
	<privacyState>public</privacyState>
</profile>`;

const NOT_FOUND_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response><error><![CDATA[The specified profile could not be found.]]></error></response>`;

function mockFetch(text, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status < 400,
      status,
      headers: { get: () => null },
      text: async () => text,
    };
  };
  return calls;
}

test('accepts a bare SteamID64', () => {
  assert.deepEqual(parseProfileInput('76561197970825039'),
    { kind: 'steamid64', value: '76561197970825039', appid: undefined, contextid: undefined });
});

test('accepts a bare vanity name', () => {
  assert.equal(parseProfileInput('b4nny').kind, 'vanity');
  assert.equal(parseProfileInput('b4nny').value, 'b4nny');
});

test('accepts the profile and inventory URL shapes Steam uses', () => {
  const cases = [
    ['https://steamcommunity.com/id/b4nny', 'vanity', 'b4nny'],
    ['https://steamcommunity.com/id/b4nny/', 'vanity', 'b4nny'],
    ['https://steamcommunity.com/id/b4nny/inventory/', 'vanity', 'b4nny'],
    ['steamcommunity.com/id/b4nny/inventory', 'vanity', 'b4nny'],
    ['https://steamcommunity.com/profiles/76561197970825039', 'steamid64', '76561197970825039'],
    ['https://steamcommunity.com/profiles/76561197970825039/inventory/', 'steamid64', '76561197970825039'],
  ];
  for (const [input, kind, value] of cases) {
    const parsed = parseProfileInput(input);
    assert.equal(parsed.kind, kind, input);
    assert.equal(parsed.value, value, input);
  }
});

test('an inventory URL fragment selects the game as well', () => {
  const parsed = parseProfileInput('https://steamcommunity.com/id/b4nny/inventory/#440_2');
  assert.equal(parsed.value, 'b4nny');
  assert.equal(parsed.appid, 440);
  assert.equal(parsed.contextid, '2');
});

test('rubbish input is rejected with a readable message', () => {
  assert.throws(() => parseProfileInput(''), /Enter a SteamID/);
  assert.throws(() => parseProfileInput('12345'), /not a valid SteamID64/);
  assert.throws(() => parseProfileInput('what is this?!'), /Could not read that/);
});

test('resolves a vanity name from the profile XML', async () => {
  const calls = mockFetch(B4NNY_XML);
  const profile = await resolveVanityName(null, 'b4nny');
  assert.equal(profile.steamId, '76561197970825039');
  assert.equal(profile.displayName, 'b4nny', 'CDATA must be unwrapped');
  assert.equal(profile.privacy, 'public');
  assert.match(calls[0].url, /steamcommunity\.com\/id\/b4nny\/\?xml=1/);
});

test('an unknown vanity name reports not-found rather than a blank id', async () => {
  mockFetch(NOT_FOUND_XML);
  await assert.rejects(() => resolveVanityName(null, 'definitely-not-a-real-user-xyz'),
    (err) => err instanceof ProfileError && err.code === 'NOT_FOUND');
});

test('resolveProfile handles a full inventory URL end to end', async () => {
  mockFetch(B4NNY_XML);
  const profile = await resolveProfile(null, 'https://steamcommunity.com/id/b4nny/inventory/#440_2');
  assert.equal(profile.steamId, '76561197970825039');
  assert.equal(profile.displayName, 'b4nny');
  assert.equal(profile.appid, 440, 'the game from the fragment is carried through');
});

test('a SteamID64 resolves without needing the vanity lookup to succeed', async () => {
  mockFetch('not xml at all', { status: 500 });
  const profile = await resolveProfile(null, '76561197970825039');
  assert.equal(profile.steamId, '76561197970825039', 'a failed name lookup must not block browsing');
  assert.equal(profile.displayName, '76561197970825039');
});

test('every known app has an appid, a context and a short name', () => {
  const seen = new Set();
  for (const app of KNOWN_APPS) {
    assert.ok(Number.isInteger(app.appid) && app.appid > 0, `${app.name} appid`);
    assert.match(app.contextid, /^\d+$/, `${app.name} contextid`);
    assert.ok(app.short && app.short.length <= 14, `${app.name} short name`);
    assert.ok(app.name, 'full name');
    assert.ok(!seen.has(app.appid), `duplicate appid ${app.appid}`);
    seen.add(app.appid);
  }
  assert.ok(KNOWN_APPS.length >= 8);
});

test('Steam community items use context 6, games use context 2', () => {
  assert.equal(appById(753).contextid, '6');
  assert.equal(appById(730).contextid, '2');
  assert.equal(appById(440).short, 'TF2');
});

test('an unknown appid becomes a usable custom entry', () => {
  const custom = appById(999999);
  assert.equal(custom.appid, 999999);
  assert.equal(custom.contextid, DEFAULT_CONTEXT_ID);
  assert.equal(custom.custom, true);
  assert.match(custom.short, /999999/);
});

test('a known appid with an unusual context is kept as given', () => {
  const odd = appById(730, '16');
  assert.equal(odd.contextid, '16');
  assert.equal(odd.short, 'CS2', 'the game is still recognised');
});
