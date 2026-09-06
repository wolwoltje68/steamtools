import test from 'node:test';
import assert from 'node:assert/strict';

import { decideOfferAction, describeOffer } from '../src/state/automation.js';
import { selectAutoConfirmable, ConfirmationType } from '../src/steam/confirmations.js';
import { TradeOfferState } from '../src/steam/trades.js';

const offer = (over = {}) => ({
  direction: 'received',
  state: TradeOfferState.Active,
  partnerSteamId: '76561198000000001',
  itemsToGive: [],
  itemsToReceive: [{ assetid: '1' }],
  ...over,
});

test('a gift offer is accepted only when gift acceptance is on', () => {
  assert.equal(decideOfferAction(offer(), { acceptGiftOffers: true }), 'accept');
  assert.equal(decideOfferAction(offer(), { acceptGiftOffers: false }), 'ignore');
});

test('an offer that takes our items is never treated as a gift', () => {
  const takesOurs = offer({ itemsToGive: [{ assetid: '9' }] });
  assert.equal(decideOfferAction(takesOurs, { acceptGiftOffers: true }), 'ignore');
});

test('an empty offer (nothing either way) is not accepted as a gift', () => {
  assert.equal(decideOfferAction(offer({ itemsToReceive: [] }), { acceptGiftOffers: true }), 'ignore');
});

test('trusted-partner acceptance is limited to the listed steamids', () => {
  const rules = { acceptFromTrusted: true, trustedSteamIds: ['76561198000000001'] };
  const takesOurs = offer({ itemsToGive: [{ assetid: '9' }] });
  assert.equal(decideOfferAction(takesOurs, rules), 'accept');

  const stranger = offer({ partnerSteamId: '76561198000000999', itemsToGive: [{ assetid: '9' }] });
  assert.equal(decideOfferAction(stranger, rules), 'ignore');
});

test('sent offers and non-active offers are never acted on', () => {
  const rules = { acceptGiftOffers: true, declineOthers: true };
  assert.equal(decideOfferAction(offer({ direction: 'sent' }), rules), 'ignore');
  for (const state of [TradeOfferState.Accepted, TradeOfferState.Expired, TradeOfferState.InEscrow,
                       TradeOfferState.Declined, TradeOfferState.CreatedNeedsConfirmation]) {
    assert.equal(decideOfferAction(offer({ state }), rules), 'ignore', `state ${state}`);
  }
});

test('declineOthers only sweeps up what was not already accepted', () => {
  const rules = { acceptGiftOffers: true, declineOthers: true };
  assert.equal(decideOfferAction(offer(), rules), 'accept');
  assert.equal(decideOfferAction(offer({ itemsToGive: [{ assetid: '9' }] }), rules), 'decline');
});

test('auto-confirm never touches account-level confirmations', () => {
  const confs = [
    { type: ConfirmationType.Trade, typeName: 'Trade' },
    { type: ConfirmationType.MarketListing, typeName: 'Market' },
    { type: ConfirmationType.PhoneNumberChange, typeName: 'Phone' },
    { type: ConfirmationType.AccountRecovery, typeName: 'Recovery' },
    { type: ConfirmationType.ApiKey, typeName: 'API key' },
  ];
  const picked = selectAutoConfirmable(confs, { autoConfirmTrades: true, autoConfirmMarket: true });
  assert.deepEqual(picked.map((c) => c.type), [ConfirmationType.Trade, ConfirmationType.MarketListing]);

  assert.deepEqual(selectAutoConfirmable(confs, {}).length, 0);
});

test('offer descriptions read sensibly', () => {
  assert.equal(describeOffer(offer()), 'receiving 1 item for nothing');
  assert.equal(describeOffer(offer({ itemsToGive: [1, 2] })), 'giving 2, receiving 1');
});
