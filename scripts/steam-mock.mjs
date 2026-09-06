// A fake Steam, good enough to drive the whole app.
//
// Installed as Playwright route handlers, so requests are answered before they
// leave the browser. Nothing here touches the real Steam, and no real account is
// involved: every secret below is randomly generated for the run.
import nodeCrypto from 'node:crypto';
import zlib from 'node:zlib';

export const DEMO = {
  accountName: 'demo_trader',
  password: 'demo-password-123',
  steamId: '76561198234567891',
  // Random per run: these are not, and must never be, real Steam secrets.
  sharedSecret: nodeCrypto.randomBytes(20).toString('base64'),
  identitySecret: nodeCrypto.randomBytes(20).toString('base64'),
};

/** A second, public profile to browse - stands in for a real one like b4nny. */
export const FOREIGN = {
  vanity: 'publictrader',
  steamId: '76561197970825039',
  displayName: 'publictrader',
};

const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const hex = (b64url) => Buffer.from(b64url, 'base64url').toString('hex');

function jwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `eyJhbGciOiJFUzI1NiJ9.${payload}.demo-signature`;
}

/** Solid-colour PNG, so item art renders instead of broken-image icons. */
function png(size, [r, g, b]) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const shade = 1 - (y / size) * 0.35;
      raw[row + 1 + x * 3] = Math.round(r * shade);
      raw[row + 2 + x * 3] = Math.round(g * shade);
      raw[row + 3 + x * 3] = Math.round(b * shade);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const ITEM_COLOURS = [
  [214, 92, 60], [92, 138, 214], [116, 178, 92], [190, 150, 60],
  [150, 96, 190], [92, 178, 178], [200, 84, 130], [120, 130, 150],
];

const ITEMS = [
  ['AK-47 | Redline', 'Classified Rifle', 1],
  ['AWP | Asiimov', 'Covert Sniper Rifle', 1],
  ['Glock-18 | Fade', 'Restricted Pistol', 1],
  ['M4A4 | Howl', 'Contraband Rifle', 1],
  ['Desert Eagle | Blaze', 'Classified Pistol', 1],
  ['Prisma Case', 'Container', 12],
  ['USP-S | Kill Confirmed', 'Covert Pistol', 1],
  ['Karambit | Doppler', 'Covert Knife', 1],
  ['Sticker | Titan (Holo)', 'High Grade Sticker', 3],
  ['Chroma 3 Case', 'Container', 7],
  ['P250 | Asiimov', 'Restricted Pistol', 2],
  ['Five-SeveN | Monkey Business', 'Classified Pistol', 1],
];

const assets = ITEMS.map((item, index) => ({
  appid: 730, contextid: '2', assetid: `A${1000 + index}`,
  classid: `C${index}`, instanceid: '0', amount: String(item[2]),
}));

const descriptions = ITEMS.map((item, index) => ({
  appid: 730, classid: `C${index}`, instanceid: '0',
  name: item[0], market_name: item[0], market_hash_name: item[0],
  type: item[1], icon_url: `ICON${index}`,
  tradable: index === 3 ? 0 : 1,
  marketable: index === 3 ? 0 : 1,
  name_color: index === 7 ? 'eb4b4b' : undefined,
  tags: [{ category: 'Type', localized_tag_name: item[1] }],
}));

const json = (body) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'Access-Control-Allow-Origin': '*', 'x-eresult': '1' },
  body: JSON.stringify(body),
});

/**
 * Attach the fake Steam to a Playwright page.
 * @returns {{seen: string[], loginPasswordWasEncrypted: boolean}} observations
 */
export async function installSteamMock(page) {
  const observed = { seen: [], loginPasswordWasEncrypted: false };
  const now = Math.floor(Date.now() / 1000);

  await page.route('**://*.steampowered.com/**', (route) => handle(route, observed, now));
  await page.route('**://*.steamcommunity.com/**', (route) => handle(route, observed, now));
  await page.route('**://steamcommunity.com/**', (route) => handle(route, observed, now));
  await page.route('**://*.steamstatic.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: png(96, ITEM_COLOURS[hashOf(route.request().url()) % ITEM_COLOURS.length]),
    })
  );

  return observed;
}

function hashOf(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

async function handle(route, observed, now) {
  const request = route.request();
  const url = request.url();
  observed.seen.push(url);

  // The app sends X-Requested-With on mobile calls, which triggers a preflight.
  if (request.method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  const form = Object.fromEntries(new URLSearchParams(request.postData() || ''));

  if (url.includes('GetPasswordRSAPublicKey')) {
    return route.fulfill(json({ response: {
      publickey_mod: hex(jwk.n), publickey_exp: hex(jwk.e), timestamp: '1',
    } }));
  }

  if (url.includes('BeginAuthSessionViaCredentials')) {
    // Prove the app never puts the password on the wire in the clear.
    try {
      const decrypted = nodeCrypto.privateDecrypt(
        { key: privateKey, padding: nodeCrypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(form.encrypted_password, 'base64')
      );
      observed.loginPasswordWasEncrypted = decrypted.toString('utf8') === DEMO.password;
    } catch (err) {
      observed.loginPasswordWasEncrypted = false;
    }
    return route.fulfill(json({ response: {
      client_id: 'CID', request_id: 'UklE', interval: 1, steamid: DEMO.steamId,
      allowed_confirmations: [{ confirmation_type: 2 }],
    } }));
  }

  if (url.includes('UpdateAuthSessionWithSteamGuardCode')) return route.fulfill(json({ response: {} }));

  if (url.includes('PollAuthSessionStatus')) {
    return route.fulfill(json({ response: {
      refresh_token: 'DEMO_REFRESH', access_token: jwt(now + 86400), account_name: DEMO.accountName,
    } }));
  }

  if (url.includes('GenerateAccessTokenForApp')) {
    return route.fulfill(json({ response: { access_token: jwt(now + 86400) } }));
  }

  if (url.includes('QueryTime')) return route.fulfill(json({ response: { server_time: String(now) } }));

  if (url.includes('GetTradeOffers')) {
    return route.fulfill(json({ response: {
      trade_offers_received: [
        { tradeofferid: '7001', accountid_other: 274302163, trade_offer_state: 2,
          time_created: now - 900, message: 'thanks for the trade!',
          items_to_give: [], items_to_receive: [assets[5], assets[9]] },
        { tradeofferid: '7002', accountid_other: 118845123, trade_offer_state: 2,
          time_created: now - 5400, message: '',
          items_to_give: [assets[0]], items_to_receive: [assets[1], assets[2]] },
      ],
      trade_offers_sent: [
        { tradeofferid: '7003', accountid_other: 55501234, trade_offer_state: 9,
          time_created: now - 300, message: 'as agreed',
          items_to_give: [assets[8]], items_to_receive: [] },
      ],
      descriptions,
    } }));
  }

  if (url.includes('mobileconf/getlist')) {
    return route.fulfill(json({ success: true, conf: [
      { id: '9001', nonce: 'n1', creator_id: '7003', type: 2, type_name: 'Trade Offer',
        headline: 'Trade with pixelhoarder', creation_time: now - 240,
        summary: ['You will give: Sticker | Titan (Holo)'], accept: 'Accept', cancel: 'Cancel',
        icon: 'https://community.cloudflare.steamstatic.com/economy/image/ICON8/64fx64f' },
      { id: '9002', nonce: 'n2', creator_id: '4411', type: 3, type_name: 'Market Listing',
        headline: 'Sell AWP | Asiimov', creation_time: now - 90,
        summary: ['Listed for €41.20', 'You receive €35.00'], accept: 'Confirm', cancel: 'Cancel',
        icon: 'https://community.cloudflare.steamstatic.com/economy/image/ICON1/64fx64f' },
    ] }));
  }

  if (url.includes('mobileconf/ajaxop') || url.includes('mobileconf/multiajaxop')) {
    return route.fulfill(json({ success: true }));
  }

  if (url.includes('?xml=1')) {
    // Profile XML, used to resolve a vanity name to a SteamID64.
    const wanted = url.match(/\/id\/([^/?]+)/);
    if (wanted && decodeURIComponent(wanted[1]) === FOREIGN.vanity) {
      return route.fulfill({
        status: 200,
        contentType: 'text/xml',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile>
  <steamID64>${FOREIGN.steamId}</steamID64>
  <steamID><![CDATA[${FOREIGN.displayName}]]></steamID>
  <privacyState>public</privacyState>
</profile>`,
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/xml',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response><error><![CDATA[The specified profile could not be found.]]></error></response>`,
    });
  }

  if (url.includes('/inventory/')) {
    const foreign = url.includes(`/inventory/${FOREIGN.steamId}/`);
    const slice = foreign ? assets.slice(0, 4) : assets;
    return route.fulfill(json({ success: 1, more_items: 0, assets: slice, descriptions,
      total_inventory_count: slice.length }));
  }

  if (url.includes('market/priceoverview')) {
    const seed = hashOf(url) % 4000;
    return route.fulfill(json({
      success: true,
      lowest_price: `€${((seed + 120) / 100).toFixed(2)}`,
      median_price: `€${((seed + 145) / 100).toFixed(2)}`,
      volume: String((seed % 400) + 12),
    }));
  }

  if (url.includes('market/sellitem')) return route.fulfill(json({ success: true, requires_confirmation: 1 }));
  if (url.includes('/accept')) return route.fulfill(json({ tradeid: '1', needs_mobile_confirmation: true }));
  if (url.includes('tradeoffer/new/send')) {
    return route.fulfill(json({ tradeofferid: '7100', needs_mobile_confirmation: true }));
  }
  if (url.includes('DeclineTradeOffer') || url.includes('CancelTradeOffer')) {
    return route.fulfill(json({ response: {} }));
  }

  return route.fulfill(json({ success: true }));
}
