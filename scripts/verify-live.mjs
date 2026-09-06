#!/usr/bin/env node
// Live check against the real Steam Community.
//
// Public inventories need no API key and no sign-in, so this runs anywhere with
// plain internet access. It deliberately calls the app's own modules rather
// than reimplementing the requests, so a pass means the shipped code handles
// Steam's real responses.
//
//   node scripts/verify-live.mjs                                  # b4nny, TF2 + CS2
//   node scripts/verify-live.mjs https://steamcommunity.com/id/b4nny/
//   node scripts/verify-live.mjs 76561197970825039 440
//
// Nothing here signs in, sends a trade or lists an item: it only reads public
// data.
import { resolveProfile } from '../src/steam/profile.js';
import { appById, getInventory } from '../src/steam/inventory.js';
import { SteamHttpError } from '../src/steam/http.js';

const DEFAULT_PROFILE = 'https://steamcommunity.com/id/b4nny/';
const target = process.argv[2] || DEFAULT_PROFILE;
const explicitApp = process.argv[3] ? Number(process.argv[3]) : null;
// b4nny is a TF2 player, so 440 is the one most likely to hold items.
const APPS = explicitApp ? [explicitApp] : [440, 730, 753];

let failures = 0;
const pass = (label, note = '') => console.log(`  ok    ${label}${note ? ` (${note})` : ''}`);
const fail = (label, why) => {
  failures += 1;
  console.log(`  FAIL  ${label}\n          ${why}`);
};

function explainNetworkError(error) {
  const message = String(error?.message || error);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|Could not reach Steam|403|tunnel/i.test(message)) {
    return `${message}\n          This machine cannot reach steamcommunity.com. Run it somewhere with plain internet access.`;
  }
  return message;
}

console.log(`\nLive Steam check against ${target}\n`);

let profile;
try {
  profile = await resolveProfile(null, target);
  if (!/^\d{17}$/.test(profile.steamId)) throw new Error(`got a malformed SteamID: ${profile.steamId}`);
  pass('resolved the profile', `${profile.displayName} -> ${profile.steamId}`);
  if (profile.privacy && profile.privacy !== 'public') {
    console.log(`  note  the profile reports privacyState "${profile.privacy}"`);
  }
} catch (error) {
  fail('resolve the profile', explainNetworkError(error));
  console.log('\nCould not continue without a SteamID.\n');
  process.exit(1);
}

let anyItemsAnywhere = false;

for (const appid of APPS) {
  const app = appById(appid);
  const label = `${app.appid} ${app.short}`;
  try {
    const items = await getInventory(null, {
      steamId: profile.steamId,
      appid: app.appid,
      contextid: app.contextid,
    });

    if (items.length === 0) {
      pass(`loaded ${label}`, 'empty for this account');
      continue;
    }
    anyItemsAnywhere = true;

    // Check the parsing actually produced usable items, not just a 200.
    const problems = [];
    const withoutName = items.filter((item) => !item.name || item.name === 'Unknown item');
    if (withoutName.length) problems.push(`${withoutName.length} items have no name`);

    const badIcon = items.filter((item) => item.iconUrl && !item.iconUrl.startsWith('https://'));
    if (badIcon.length) problems.push(`${badIcon.length} items have a malformed icon URL`);

    const badAsset = items.filter((item) => !/^\d+$/.test(item.assetid));
    if (badAsset.length) problems.push(`${badAsset.length} items have a non-numeric assetid`);

    const duplicates = items.length - new Set(items.map((item) => item.key)).size;
    if (duplicates) problems.push(`${duplicates} duplicate item keys`);

    if (typeof items[0].tradable !== 'boolean') problems.push('tradable flag is not a boolean');
    if (typeof items[0].marketable !== 'boolean') problems.push('marketable flag is not a boolean');

    if (problems.length) {
      fail(`parse ${label}`, problems.join('; '));
    } else {
      const tradable = items.filter((item) => item.tradable).length;
      const marketable = items.filter((item) => item.marketable).length;
      pass(
        `loaded ${label}`,
        `${items.length} items, ${tradable} tradable, ${marketable} marketable`
      );
      console.log(`          e.g. ${items[0].name}${items[0].type ? ` - ${items[0].type}` : ''}`);
    }
  } catch (error) {
    // A private or empty inventory is Steam's answer, not a bug in the app.
    if (error instanceof SteamHttpError && /private|no inventory/i.test(error.message)) {
      pass(`loaded ${label}`, 'private or empty');
    } else {
      fail(`load ${label}`, explainNetworkError(error));
    }
  }

  // Steam rate-limits inventory reads per IP; do not hammer it.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

if (!anyItemsAnywhere && failures === 0) {
  console.log('\n  note  every inventory came back empty or private, so parsing was not exercised.');
  console.log('        Try another public profile: node scripts/verify-live.mjs <profile URL>');
}

console.log(
  failures === 0
    ? '\nLive check passed: real Steam responses parsed correctly.\n'
    : `\n${failures} live check(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
