import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCookieHeader, encodeForm, newSessionId, isSessionExpired, SteamHttpError } from '../src/steam/http.js';
import { fetchConfirmations, respondToConfirmation } from '../src/steam/confirmations.js';
import { getTradeOffers, sendTradeOffer, acceptTradeOffer, parseTradeUrl } from '../src/steam/trades.js';
import { getInventory } from '../src/steam/inventory.js';
import { createSellListing, estimateFees, receivedFromBuyerPays, parsePriceToCents, formatPrice } from '../src/steam/market.js';
import { _setTimeOffset } from '../src/steam/time.js';
import { accountIdToSteamId64, steamId64ToAccountId } from '../src/steam/steamid.js';

_setTimeOffset(0); // avoid a live QueryTime call

const ACCOUNT = {
  id: 'a1',
  accountName: 'tester',
  steamId: '76561198234567891',
  sharedSecret: 'BGhtL4KLGRUtV1sNRPRVQfLBnQE=',
  identitySecret: 'Yf0aP3nDh0y8mQ2iWzKrLzXbVvM=',
  deviceId: 'android:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  sessionId: 'abcdef0123456789abcdef01',
  accessToken: 'eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig',
};

/** Capture requests and reply with queued canned responses. */
function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request to ${url}`);
    return {
      ok: next.status ? next.status < 400 : true,
      status: next.status || 200,
      headers: { get: (name) => (name.toLowerCase() === 'x-eresult' ? next.eresult ?? null : null) },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  return calls;
}

test('cookie header carries steamLoginSecure in Steam\'s own encoding', () => {
  const cookie = buildCookieHeader(ACCOUNT);
  assert.match(cookie, /sessionid=abcdef0123456789abcdef01/);
  assert.match(cookie, /steamLoginSecure=76561198234567891%7C%7CeyJ/,
    'steamid and token must be joined by a percent-encoded ||');
  assert.doesNotMatch(cookie, /mobileClient/, 'mobile cookies only when asked for');
});

test('mobile requests add the Steam app cookies', () => {
  const cookie = buildCookieHeader(ACCOUNT, { mobile: true });
  assert.match(cookie, /mobileClient=android/);
  assert.match(cookie, /mobileClientVersion=/);
});

test('a signed-out account sends no session cookie', () => {
  const cookie = buildCookieHeader({ ...ACCOUNT, accessToken: null });
  assert.doesNotMatch(cookie, /steamLoginSecure/);
});

test('session ids look like Steam session ids', () => {
  assert.match(newSessionId(), /^[0-9a-f]{24}$/);
});

test('form encoding repeats array keys, as multiajaxop needs', () => {
  const encoded = encodeForm({ op: 'allow', 'cid[]': ['1', '2'], skip: undefined });
  assert.equal(encoded, 'op=allow&cid%5B%5D=1&cid%5B%5D=2');
});

test('confirmations are fetched with a signed, mobile request', async () => {
  const calls = mockFetch([
    { body: { success: true, conf: [{ id: '77', nonce: '88', creator_id: '99', type: 2,
        type_name: 'Trade Offer', headline: 'Trade with X', summary: ['1 item'], creation_time: 1700000000 }] } },
  ]);

  const confirmations = await fetchConfirmations(ACCOUNT);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(
    { id: confirmations[0].id, creatorId: confirmations[0].creatorId, type: confirmations[0].type },
    { id: '77', creatorId: '99', type: 2 }
  );

  const { url, options } = calls[0];
  assert.match(url, /mobileconf\/getlist/);
  for (const param of ['p=android', 'a=76561198234567891', 'k=', 't=', 'm=react', 'tag=conf']) {
    assert.ok(url.includes(param), `missing ${param} in ${url}`);
  }
  assert.equal(options.credentials, 'omit', 'must bypass the shared native cookie jar');
  assert.match(options.headers.Cookie, /mobileClient=android/);
});

test('accepting a confirmation signs with the allow tag', async () => {
  const calls = mockFetch([{ body: { success: true } }]);
  await respondToConfirmation(ACCOUNT, { id: '77', nonce: '88' }, true);
  assert.match(calls[0].url, /op=allow/);
  assert.match(calls[0].url, /tag=allow/);
  assert.match(calls[0].url, /cid=77/);
  assert.match(calls[0].url, /ck=88/);
});

test('a rejected confirmation surfaces Steam\'s message', async () => {
  mockFetch([{ body: { success: false, message: 'Oh nooooooes!' } }]);
  await assert.rejects(() => respondToConfirmation(ACCOUNT, { id: '1', nonce: '2' }, true), /Oh nooooooes/);
});

test('trade offers join their description table', async () => {
  mockFetch([{ body: { response: {
    trade_offers_received: [{
      tradeofferid: '5001', accountid_other: 274302163, trade_offer_state: 2,
      time_created: 1700000000, message: 'hi',
      items_to_receive: [{ appid: 730, contextid: '2', assetid: 'A1', classid: 'C1', instanceid: '0', amount: '1' }],
    }],
    trade_offers_sent: [],
    descriptions: [{ appid: 730, classid: 'C1', instanceid: '0', market_name: 'AK-47 | Redline', icon_url: 'ICON' }],
  } } }]);

  const { received } = await getTradeOffers(ACCOUNT);
  assert.equal(received.length, 1);
  assert.equal(received[0].itemsToReceive[0].name, 'AK-47 | Redline');
  assert.equal(received[0].isGift, true, 'nothing given means it is a gift');
  assert.equal(received[0].partnerSteamId, accountIdToSteamId64(274302163));
});

test('sending a trade builds the offer json Steam expects', async () => {
  const calls = mockFetch([{ body: { tradeofferid: '9001', needs_mobile_confirmation: true } }]);
  const items = [{ appid: 730, contextid: '2', assetid: 'A1', amount: 1, tradable: true }];

  const result = await sendTradeOffer(ACCOUNT, {
    tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=274302163&token=AbCd1234',
    items,
    message: 'here you go',
  });
  assert.equal(result.tradeOfferId, '9001');
  assert.equal(result.needsMobileConfirmation, true);

  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('sessionid'), ACCOUNT.sessionId);
  assert.equal(body.get('partner'), accountIdToSteamId64(274302163));
  assert.equal(JSON.parse(body.get('trade_offer_create_params')).trade_offer_access_token, 'AbCd1234');

  const offer = JSON.parse(body.get('json_tradeoffer'));
  assert.deepEqual(offer.me.assets, [{ appid: 730, contextid: '2', amount: 1, assetid: 'A1' }]);
  assert.deepEqual(offer.them.assets, [], 'we must never request items from the other side');
  assert.equal(offer.newversion, true);

  // Referer matters: Steam rejects the POST without a matching one.
  assert.match(calls[0].options.headers.Referer, /partner=274302163&token=AbCd1234/);
});

test('a trade URL without a token is refused before any request', async () => {
  mockFetch([]);
  await assert.rejects(
    () => sendTradeOffer(ACCOUNT, { tradeUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=274302163', items: [{ assetid: '1' }] }),
    /no token/
  );
});

test('Steam trade errors are translated, not shown raw', async () => {
  mockFetch([{ body: { strError: 'There was an error accepting this trade offer. (26)' } }]);
  await assert.rejects(
    () => acceptTradeOffer(ACCOUNT, { id: '1', partnerSteamId: '76561198000000001' }),
    /no longer in the inventory/
  );
});

test('inventory follows pagination and joins descriptions', async () => {
  mockFetch([
    { body: {
      success: 1, more_items: 1, last_assetid: 'A2',
      assets: [{ appid: 730, contextid: '2', assetid: 'A1', classid: 'C1', instanceid: '0', amount: '1' }],
      descriptions: [{ classid: 'C1', instanceid: '0', name: 'Case', market_hash_name: 'Case',
        icon_url: 'ICON1', tradable: 1, marketable: 1 }],
    } },
    { body: {
      success: 1, more_items: 0,
      assets: [{ appid: 730, contextid: '2', assetid: 'A2', classid: 'C2', instanceid: '0', amount: '5' }],
      descriptions: [{ classid: 'C2', instanceid: '0', name: 'Sticker', market_hash_name: 'Sticker',
        icon_url: 'ICON2', tradable: 0, marketable: 1 }],
    } },
  ]);

  const items = await getInventory(ACCOUNT, { appid: 730, contextid: '2' });
  assert.equal(items.length, 2, 'both pages must be collected');
  assert.equal(items[0].name, 'Case');
  assert.equal(items[0].tradable, true);
  assert.equal(items[1].tradable, false);
  assert.equal(items[1].amount, 5);
  assert.match(items[0].iconUrl, /^https:\/\/community\.cloudflare\.steamstatic\.com\/economy\/image\/ICON1\//);
  assert.equal(items[0].key, '730_2_A1');
});

test('a private inventory is explained rather than shown as empty', async () => {
  mockFetch([{ body: null }]);
  await assert.rejects(() => getInventory(ACCOUNT, { appid: 730, contextid: '2' }), /private/);
});

test('market listing posts the amount the seller receives', async () => {
  const calls = mockFetch([{ body: { success: true, requires_confirmation: 1 } }]);
  const result = await createSellListing(ACCOUNT, {
    appid: 730, contextid: '2', assetid: 'A1', receivesCents: 435,
  });
  assert.equal(result.needsConfirmation, true);

  const body = new URLSearchParams(calls[0].options.body);
  assert.equal(body.get('price'), '435');
  assert.equal(body.get('assetid'), 'A1');
  assert.equal(body.get('sessionid'), ACCOUNT.sessionId);
});

test('fee maths round-trips between what the buyer pays and what you receive', () => {
  for (let receives = 3; receives < 5000; receives += 7) {
    const { buyerPays } = estimateFees(receives);
    assert.ok(buyerPays > receives, 'the buyer always pays more than the seller receives');
    assert.equal(receivedFromBuyerPays(buyerPays), receives, `round trip failed at ${receives}`);
  }
});

test('prices parse from the formats Steam renders', () => {
  assert.equal(parsePriceToCents('$12.34'), 1234);
  assert.equal(parsePriceToCents('€1.234,56'), 123456);
  assert.equal(parsePriceToCents('1,23 zł'), 123);
  assert.equal(parsePriceToCents('0.03'), 3);
  assert.equal(parsePriceToCents(''), 0);
  assert.equal(formatPrice(1234, 1), '$12.34');
});

test('steamid conversions are exact at 64-bit width', () => {
  assert.equal(accountIdToSteamId64('274302163'), '76561198234567891');
  assert.equal(steamId64ToAccountId('76561198234567891'), '274302163');
});

test('trade URL parsing', () => {
  const parsed = parseTradeUrl('https://steamcommunity.com/tradeoffer/new/?partner=274302163&token=AbCd1234');
  assert.deepEqual(parsed, {
    partnerAccountId: '274302163',
    partnerSteamId: '76561198234567891',
    token: 'AbCd1234',
  });
  assert.throws(() => parseTradeUrl('https://example.com/nope'), /partner=/);
});

test('expired sessions are recognised so callers can re-authenticate', () => {
  assert.equal(isSessionExpired(new SteamHttpError('x', { status: 401 })), true);
  assert.equal(isSessionExpired(new SteamHttpError('x', { status: 500 })), false);
  assert.equal(isSessionExpired(new Error('x')), false);
});
