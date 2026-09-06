import test from 'node:test';
import assert from 'node:assert/strict';

import { AutomationEngine } from '../src/state/automation.js';
import { normaliseAutomation } from '../src/steam/maFile.js';
import { _setTimeOffset } from '../src/steam/time.js';

_setTimeOffset(0);

const ACCOUNT = {
  id: 'a1',
  accountName: 'tester',
  steamId: '76561198234567891',
  identitySecret: 'Yf0aP3nDh0y8mQ2iWzKrLzXbVvM=',
  deviceId: 'android:aaaa-bbbb',
  sessionId: 'abcdef0123456789abcdef01',
  accessToken: 'token',
};

/** Record every Steam call by kind so we can assert on what automation did. */
function mockSteam({ received = [], confirmations = [] } = {}) {
  const actions = { accepted: [], declined: [], confirmed: [], cancelled: [] };
  globalThis.fetch = async (url, options) => {
    const body = options.body ? Object.fromEntries(new URLSearchParams(options.body)) : {};
    let payload = { success: true };

    if (url.includes('GetTradeOffers')) {
      payload = { response: { trade_offers_received: received, trade_offers_sent: [], descriptions: [] } };
    } else if (url.includes('/accept')) {
      actions.accepted.push(url.match(/tradeoffer\/(\d+)\//)[1]);
      payload = { tradeid: '1' };
    } else if (url.includes('DeclineTradeOffer') || url.includes('CancelTradeOffer')) {
      actions.declined.push(body.tradeofferid);
      payload = { response: {} };
    } else if (url.includes('mobileconf/getlist')) {
      payload = { success: true, conf: confirmations };
    } else if (url.includes('multiajaxop')) {
      const ids = new URLSearchParams(options.body).getAll('cid[]');
      (url.includes('tag=allow') || body.op === 'allow' ? actions.confirmed : actions.cancelled).push(...ids);
    } else if (url.includes('ajaxop')) {
      const id = new URL(url).searchParams.get('cid');
      (url.includes('op=allow') ? actions.confirmed : actions.cancelled).push(id);
    }

    return {
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(payload),
    };
  };
  return actions;
}

function engineFor(rules, logs = []) {
  const account = { ...ACCOUNT, automation: normaliseAutomation(rules) };
  const engine = new AutomationEngine({
    getAccounts: () => [account],
    ensureSession: async () => account,
    onLog: (entry) => logs.push(entry),
  });
  return { engine, account };
}

const offer = (id, { give = [], receive = [{ assetid: 'x' }], partner = 274302163, state = 2 } = {}) => ({
  tradeofferid: id, accountid_other: partner, trade_offer_state: state,
  items_to_give: give, items_to_receive: receive,
});

test('a gift offer is accepted automatically', async () => {
  const actions = mockSteam({ received: [offer('5001')] });
  const { engine, account } = engineFor({ enabled: true, acceptGiftOffers: true });
  await engine.runOnce(account);
  assert.deepEqual(actions.accepted, ['5001']);
});

test('an offer that takes items is left alone when only gifts are enabled', async () => {
  const actions = mockSteam({ received: [offer('5002', { give: [{ assetid: 'mine' }] })] });
  const { engine, account } = engineFor({ enabled: true, acceptGiftOffers: true });
  await engine.runOnce(account);
  assert.deepEqual(actions.accepted, [], 'must never give items away unprompted');
  assert.deepEqual(actions.declined, []);
});

test('offers from a trusted partner are accepted even when they take items', async () => {
  const actions = mockSteam({ received: [offer('5003', { give: [{ assetid: 'mine' }] })] });
  const { engine, account } = engineFor({
    enabled: true, acceptFromTrusted: true, trustedSteamIds: ['76561198234567891'],
  });
  await engine.runOnce(account);
  assert.deepEqual(actions.accepted, ['5003']);
});

test('an untrusted partner is not accepted', async () => {
  const actions = mockSteam({ received: [offer('5004', { give: [{ assetid: 'mine' }], partner: 999 })] });
  const { engine, account } = engineFor({
    enabled: true, acceptFromTrusted: true, trustedSteamIds: ['76561198234567891'],
  });
  await engine.runOnce(account);
  assert.deepEqual(actions.accepted, []);
});

test('trade and market confirmations are approved, account changes are not', async () => {
  const actions = mockSteam({
    confirmations: [
      { id: '11', nonce: 'n1', creator_id: 'c1', type: 2, type_name: 'Trade' },
      { id: '12', nonce: 'n2', creator_id: 'c2', type: 3, type_name: 'Market' },
      { id: '13', nonce: 'n3', creator_id: 'c3', type: 5, type_name: 'Phone number change' },
      { id: '14', nonce: 'n4', creator_id: 'c4', type: 6, type_name: 'Account recovery' },
    ],
  });
  const { engine, account } = engineFor({ enabled: true, confirmTrades: true, confirmMarket: true });
  await engine.runOnce(account);

  assert.deepEqual(actions.confirmed.sort(), ['11', '12']);
  assert.ok(!actions.confirmed.includes('13'), 'phone number changes must never be auto-approved');
  assert.ok(!actions.confirmed.includes('14'), 'account recovery must never be auto-approved');
  assert.deepEqual(actions.cancelled, []);
});

test('only market confirmations are touched when only market is enabled', async () => {
  const actions = mockSteam({
    confirmations: [
      { id: '21', nonce: 'n1', creator_id: 'c1', type: 2, type_name: 'Trade' },
      { id: '22', nonce: 'n2', creator_id: 'c2', type: 3, type_name: 'Market' },
    ],
  });
  const { engine, account } = engineFor({ enabled: true, confirmMarket: true });
  await engine.runOnce(account);
  assert.deepEqual(actions.confirmed, ['22']);
});

test('automation with everything off makes no Steam calls at all', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
  };
  const { engine, account } = engineFor({ enabled: true });
  await engine.runOnce(account);
  assert.equal(requests, 0);
});

test('a failing account backs off instead of hammering Steam', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const logs = [];
  const { engine, account } = engineFor({ enabled: true, acceptGiftOffers: true, intervalSeconds: 30 }, logs);

  await engine.tick();
  const first = engine.stateFor(account.id);
  assert.equal(first.failures, 1);
  const firstDelay = first.nextRunAt - Date.now();

  await engine.tick(); // not due yet, so nothing changes
  assert.equal(engine.stateFor(account.id).failures, 1, 'must respect its own backoff window');

  engine.scheduleNow(account.id);
  await engine.tick();
  const second = engine.stateFor(account.id);
  assert.equal(second.failures, 2);
  assert.ok(second.nextRunAt - Date.now() > firstDelay, 'backoff must grow after repeated failures');
  assert.ok(logs.some((entry) => entry.kind === 'error'));
});

test('a disabled account is never polled', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('should not happen'); };
  const { engine } = engineFor({ enabled: false, acceptGiftOffers: true });
  await engine.tick();
  assert.equal(requests, 0);
});

test('acting on one offer does not stop the rest', async () => {
  const actions = mockSteam({ received: [offer('6001'), offer('6002')] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.includes('tradeoffer/6001/accept')) throw new Error('Steam hiccup');
    return originalFetch(url, options);
  };
  const logs = [];
  const { engine, account } = engineFor({ enabled: true, acceptGiftOffers: true }, logs);
  await engine.runOnce(account);

  assert.deepEqual(actions.accepted, ['6002'], 'the second offer must still be processed');
  assert.ok(logs.some((entry) => entry.kind === 'error' && entry.message.includes('6001')));
});
