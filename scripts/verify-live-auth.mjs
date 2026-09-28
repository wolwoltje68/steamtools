#!/usr/bin/env node
// Signed-in live check against the real Steam, for a real account.
//
// READ-ONLY BY CONSTRUCTION. It signs in, then only *reads*: trade offers,
// pending confirmations, inventory, market listings. It deliberately does not
// import acceptTradeOffer, declineTradeOffer, sendTradeOffer,
// respondToConfirmation(s) or createSellListing, so no run of this script can
// move an item, accept a trade or list anything for sale.
//
// Run it on your own machine. Credentials come from the environment or a
// maFile on disk, never from an argument, so they stay out of your shell
// history. Nothing secret is printed: tokens and secrets are masked, so the
// output is safe to paste into a bug report.
//
//   export STEAM_ACCOUNT=yourname
//   export STEAM_PASSWORD='...'
//   export STEAM_SHARED_SECRET='base64=='        # for the Guard code
//   export STEAM_IDENTITY_SECRET='base64=='      # optional, for confirmations
//   node scripts/verify-live-auth.mjs
//
// or, using a maFile you already have:
//
//   export STEAM_PASSWORD='...'                  # unless the maFile holds it
//   node scripts/verify-live-auth.mjs --mafile ./yourname.maFile
//
// Steam will treat this as a new sign-in and may email you about it. That is
// expected: it is a genuine login through the same code path the app uses.
import { readFileSync } from 'node:fs';

import { login, needsRenewal } from '../src/steam/session.js';
import { generateAuthCode } from '../src/steam/guard.js';
import { syncSteamTime, steamUnixTime, getTimeOffset } from '../src/steam/time.js';
import { getTradeOffers } from '../src/steam/trades.js';
import { fetchConfirmations } from '../src/steam/confirmations.js';
import { getInventory, appById } from '../src/steam/inventory.js';
import { getMyListings } from '../src/steam/market.js';
import { parseMaFileText } from '../src/steam/maFile.js';
import { newSessionId } from '../src/steam/http.js';

let failures = 0;
const pass = (label, note = '') => console.log(`  ok    ${label}${note ? ` (${note})` : ''}`);
const fail = (label, why) => {
  failures += 1;
  console.log(`  FAIL  ${label}\n          ${why}`);
};
const note = (text) => console.log(`  note  ${text}`);

/** Never print a secret in full; enough to confirm it is present and distinct. */
const mask = (value) => {
  if (!value) return '(none)';
  const text = String(value);
  return `${text.slice(0, 4)}…${text.slice(-3)} [${text.length} chars]`;
};

function loadCredentials() {
  const maFileFlag = process.argv.indexOf('--mafile');
  if (maFileFlag !== -1) {
    const path = process.argv[maFileFlag + 1];
    if (!path) throw new Error('--mafile needs a path');
    const account = parseMaFileText(readFileSync(path, 'utf8'));
    return {
      accountName: process.env.STEAM_ACCOUNT || account.accountName,
      password: process.env.STEAM_PASSWORD || account.password,
      sharedSecret: account.sharedSecret,
      identitySecret: account.identitySecret,
      steamId: account.steamId,
      deviceId: account.deviceId,
      source: `maFile ${path}`,
    };
  }
  return {
    accountName: process.env.STEAM_ACCOUNT,
    password: process.env.STEAM_PASSWORD,
    sharedSecret: process.env.STEAM_SHARED_SECRET,
    identitySecret: process.env.STEAM_IDENTITY_SECRET,
    source: 'environment variables',
  };
}

let credentials;
try {
  credentials = loadCredentials();
} catch (error) {
  console.error(`\nCould not read the credentials: ${error.message}\n`);
  process.exit(1);
}

if (!credentials.accountName || !credentials.password) {
  console.error(`
Missing credentials. This script never takes them as arguments, so they do not
end up in your shell history.

  export STEAM_ACCOUNT=yourname
  export STEAM_PASSWORD='...'
  export STEAM_SHARED_SECRET='base64=='
  node scripts/verify-live-auth.mjs

or:  node scripts/verify-live-auth.mjs --mafile ./yourname.maFile
`);
  process.exit(1);
}

console.log(`\nSigned-in live check - READ ONLY, nothing is accepted, sent or listed`);
console.log(`Credentials from: ${credentials.source}`);
console.log(`Account: ${credentials.accountName}   shared_secret: ${mask(credentials.sharedSecret)}\n`);

// --- 1. Steam's clock ------------------------------------------------------
try {
  await syncSteamTime({ force: true });
  const offset = getTimeOffset();
  pass('synced with Steam time', `${offset >= 0 ? '+' : ''}${offset}s drift on this machine`);
  if (Math.abs(offset) > 30) {
    note('a drift above 30s would break Guard codes without this correction');
  }
} catch (error) {
  fail('sync with Steam time', error.message);
}

// --- 2. Guard code ---------------------------------------------------------
if (credentials.sharedSecret) {
  try {
    const code = generateAuthCode(credentials.sharedSecret, steamUnixTime());
    if (!/^[23456789BCDFGHJKMNPQRTVWXY]{5}$/.test(code)) throw new Error(`got "${code}"`);
    pass('generated a Guard code', `${code} - compare it with the Steam app right now`);
  } catch (error) {
    fail('generate a Guard code', error.message);
  }
} else {
  note('no shared_secret given, so sign-in needs a code you type in Steam yourself');
}

// --- 3. Sign in ------------------------------------------------------------
let account = null;
try {
  const result = await login({
    accountName: credentials.accountName,
    password: credentials.password,
    sharedSecret: credentials.sharedSecret,
    deviceName: 'SteamTools live check',
  });
  account = {
    ...credentials,
    steamId: result.steamId,
    accountName: result.accountName,
    refreshToken: result.refreshToken,
    accessToken: result.accessToken,
    accessTokenExpires: result.accessTokenExpires,
    sessionId: result.sessionId || newSessionId(),
  };
  const hours = Math.round((result.accessTokenExpires - Date.now() / 1000) / 3600);
  pass('signed in', `steamid ${result.steamId}, token ${mask(result.accessToken)}, valid ~${hours}h`);
  if (needsRenewal(account)) fail('token freshness', 'the new token already reports as needing renewal');
} catch (error) {
  fail('sign in', error.message);
  console.log('\nCannot continue without a session.\n');
  process.exit(1);
}

// --- 4. Trade offers -------------------------------------------------------
try {
  const { received, sent } = await getTradeOffers(account, { activeOnly: true });
  pass('read trade offers', `${received.length} incoming, ${sent.length} outgoing`);
  for (const offer of [...received, ...sent].slice(0, 5)) {
    console.log(
      `          ${offer.direction.padEnd(8)} #${offer.id} ${offer.stateName}` +
        ` - give ${offer.itemsToGive.length}, get ${offer.itemsToReceive.length}` +
        (offer.isGift ? ' [gift]' : '')
    );
  }
  const unnamed = [...received, ...sent].flatMap((offer) =>
    [...offer.itemsToGive, ...offer.itemsToReceive].filter((item) => /^Item \d+$/.test(item.name))
  );
  if (unnamed.length) fail('name trade items', `${unnamed.length} items fell back to a placeholder name`);
} catch (error) {
  fail('read trade offers', error.message);
}

// --- 5. Confirmations ------------------------------------------------------
if (account.identitySecret) {
  try {
    const confirmations = await fetchConfirmations(account);
    pass('read pending confirmations', `${confirmations.length} waiting`);
    for (const confirmation of confirmations.slice(0, 5)) {
      console.log(`          ${confirmation.typeName}: ${confirmation.headline || '(no headline)'}`);
    }
    note('none of these were approved or cancelled - this script only reads');
  } catch (error) {
    fail('read pending confirmations', error.message);
  }
} else {
  note('no identity_secret given, so confirmations were not checked');
}

// --- 6. Inventory ----------------------------------------------------------
for (const appid of [730, 753]) {
  const app = appById(appid);
  try {
    const items = await getInventory(account, {
      steamId: account.steamId,
      appid: app.appid,
      contextid: app.contextid,
    });
    if (items.length === 0) {
      pass(`read ${app.appid} ${app.short} inventory`, 'empty');
    } else {
      const tradable = items.filter((item) => item.tradable).length;
      pass(
        `read ${app.appid} ${app.short} inventory`,
        `${items.length} items, ${tradable} tradable`
      );
      console.log(`          e.g. ${items[0].name}${items[0].type ? ` - ${items[0].type}` : ''}`);
    }
  } catch (error) {
    fail(`read ${app.appid} ${app.short} inventory`, error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

// --- 7. Market listings ----------------------------------------------------
try {
  const listings = await getMyListings(account);
  pass('read your market listings', `${listings.length} active`);
} catch (error) {
  fail('read your market listings', error.message);
}

console.log(
  failures === 0
    ? '\nAll signed-in checks passed against the real Steam.\n'
    : `\n${failures} signed-in check(s) failed.\n`
);
console.log('Nothing was accepted, sent, confirmed or listed.\n');
process.exit(failures === 0 ? 0 : 1);
