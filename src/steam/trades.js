// Trade offers: listing, accepting, declining and sending.
//
// Reads go through IEconService with the JWT access token (no legacy API key
// needed); writes that Steam only exposes to the website go through
// steamcommunity.com with the session cookie.
import { API, COMMUNITY, SteamHttpError, steamRequest } from './http.js';
import { accountIdToSteamId64 } from './steamid.js';

/** ETradeOfferState */
export const TradeOfferState = {
  Invalid: 1,
  Active: 2,
  Accepted: 3,
  Countered: 4,
  Expired: 5,
  Canceled: 6,
  Declined: 7,
  InvalidItems: 8,
  CreatedNeedsConfirmation: 9,
  CanceledBySecondFactor: 10,
  InEscrow: 11,
};

export function describeTradeState(state) {
  const names = {
    1: 'Invalid',
    2: 'Active',
    3: 'Accepted',
    4: 'Countered',
    5: 'Expired',
    6: 'Cancelled',
    7: 'Declined',
    8: 'Invalid items',
    9: 'Awaiting confirmation',
    10: 'Cancelled by Guard',
    11: 'In escrow',
  };
  return names[Number(state)] || `State ${state}`;
}

function requireToken(account) {
  if (!account.accessToken) {
    throw new SteamHttpError(`${account.accountName} is not signed in`, { status: 401 });
  }
}

/**
 * Parse a trade offer URL.
 * @returns {{partnerAccountId: string, partnerSteamId: string, token: string|null}}
 */
export function parseTradeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('Enter a trade offer URL');

  const partnerMatch = trimmed.match(/[?&]partner=(\d+)/);
  if (!partnerMatch) {
    throw new Error('That does not look like a trade offer URL - it needs a "partner=" value');
  }
  const tokenMatch = trimmed.match(/[?&]token=([A-Za-z0-9_-]+)/);

  return {
    partnerAccountId: partnerMatch[1],
    partnerSteamId: accountIdToSteamId64(partnerMatch[1]),
    token: tokenMatch ? tokenMatch[1] : null,
  };
}

/** Normalise one raw IEconService offer plus the shared description table. */
function normaliseOffer(raw, descriptions, direction) {
  const lookup = (item) => descriptions.get(`${item.appid}_${item.classid}_${item.instanceid}`);
  const decorate = (items = []) =>
    items.map((item) => {
      const description = lookup(item) || {};
      return {
        appid: item.appid,
        contextid: item.contextid,
        assetid: item.assetid,
        classid: item.classid,
        instanceid: item.instanceid,
        amount: Number(item.amount) || 1,
        name: description.market_name || description.name || `Item ${item.assetid}`,
        iconUrl: description.icon_url || null,
        nameColor: description.name_color || null,
        type: description.type || '',
      };
    });

  return {
    id: String(raw.tradeofferid),
    direction,
    partnerSteamId: accountIdToSteamId64(raw.accountid_other),
    partnerAccountId: String(raw.accountid_other),
    message: raw.message || '',
    state: Number(raw.trade_offer_state),
    stateName: describeTradeState(raw.trade_offer_state),
    expiresAt: Number(raw.expiration_time) || 0,
    updatedAt: Number(raw.time_updated) || 0,
    createdAt: Number(raw.time_created) || 0,
    escrowDays: Number(raw.escrow_end_date) ? Number(raw.escrow_end_date) : 0,
    confirmationNeeded: Number(raw.confirmation_method) > 0,
    itemsToGive: decorate(raw.items_to_give),
    itemsToReceive: decorate(raw.items_to_receive),
    isGift: (raw.items_to_give || []).length === 0 && (raw.items_to_receive || []).length > 0,
  };
}

/**
 * Fetch trade offers.
 * @param {object} account
 * @param {{activeOnly?: boolean, historicalCutoffDays?: number}} options
 */
export async function getTradeOffers(account, { activeOnly = true, historicalCutoffDays = 7 } = {}) {
  requireToken(account);

  const cutoff = Math.floor(Date.now() / 1000) - historicalCutoffDays * 86400;
  const { data } = await steamRequest(account, `${API}/IEconService/GetTradeOffers/v1/`, {
    query: {
      access_token: account.accessToken,
      get_received_offers: 'true',
      get_sent_offers: 'true',
      get_descriptions: 'true',
      language: 'english',
      active_only: activeOnly ? 'true' : 'false',
      time_historical_cutoff: activeOnly ? undefined : String(cutoff),
    },
  });

  const response = data?.response || {};
  const descriptions = new Map();
  for (const description of response.descriptions || []) {
    descriptions.set(`${description.appid}_${description.classid}_${description.instanceid}`, description);
  }

  const received = (response.trade_offers_received || []).map((offer) =>
    normaliseOffer(offer, descriptions, 'received')
  );
  const sent = (response.trade_offers_sent || []).map((offer) => normaliseOffer(offer, descriptions, 'sent'));
  return { received, sent };
}

/** Accept an incoming offer. Steam only exposes this on the community site. */
export async function acceptTradeOffer(account, offer) {
  requireToken(account);
  const { data } = await steamRequest(account, `${COMMUNITY}/tradeoffer/${offer.id}/accept`, {
    method: 'POST',
    form: {
      sessionid: account.sessionId,
      serverid: '1',
      tradeofferid: offer.id,
      partner: offer.partnerSteamId,
      captcha: '',
    },
    referer: `${COMMUNITY}/tradeoffer/${offer.id}/`,
  });

  if (data?.strError) throw new SteamHttpError(cleanSteamError(data.strError));
  return {
    tradeId: data?.tradeid ? String(data.tradeid) : null,
    needsMobileConfirmation: !!data?.needs_mobile_confirmation,
    needsEmailConfirmation: !!data?.needs_email_confirmation,
  };
}

export async function declineTradeOffer(account, offer) {
  requireToken(account);
  const endpoint = offer.direction === 'sent' ? 'CancelTradeOffer' : 'DeclineTradeOffer';
  await steamRequest(account, `${API}/IEconService/${endpoint}/v1/`, {
    method: 'POST',
    form: { access_token: account.accessToken, tradeofferid: offer.id },
  });
  return true;
}

/**
 * Send a trade offer containing `items` to the owner of `tradeUrl`.
 *
 * @param {object} account
 * @param {{tradeUrl: string, items: Array, message?: string}} params
 */
export async function sendTradeOffer(account, { tradeUrl, items, message = '' }) {
  requireToken(account);
  if (!items || items.length === 0) throw new Error('Select at least one item to send');

  const { partnerAccountId, partnerSteamId, token } = parseTradeUrl(tradeUrl);
  if (!token) {
    throw new Error('This trade URL has no token. Ask the other person for their full trade offer URL.');
  }

  const offer = {
    newversion: true,
    version: items.length + 1,
    me: {
      assets: items.map((item) => ({
        appid: Number(item.appid),
        contextid: String(item.contextid),
        amount: Number(item.amount) || 1,
        assetid: String(item.assetid),
      })),
      currency: [],
      ready: false,
    },
    them: { assets: [], currency: [], ready: false },
  };

  const referer = `${COMMUNITY}/tradeoffer/new/?partner=${partnerAccountId}&token=${token}`;
  const { data } = await steamRequest(account, `${COMMUNITY}/tradeoffer/new/send`, {
    method: 'POST',
    form: {
      sessionid: account.sessionId,
      serverid: '1',
      partner: partnerSteamId,
      tradeoffermessage: message,
      json_tradeoffer: JSON.stringify(offer),
      captcha: '',
      trade_offer_create_params: JSON.stringify({ trade_offer_access_token: token }),
    },
    referer,
    headers: { Origin: COMMUNITY },
  });

  if (data?.strError) throw new SteamHttpError(cleanSteamError(data.strError));
  if (!data?.tradeofferid) throw new SteamHttpError('Steam did not return a trade offer id');

  return {
    tradeOfferId: String(data.tradeofferid),
    needsMobileConfirmation: !!data.needs_mobile_confirmation,
    needsEmailConfirmation: !!data.needs_email_confirmation,
  };
}

/** Steam's errors carry an internal code in brackets; make them readable. */
export function cleanSteamError(raw) {
  const text = String(raw);
  const codeMatch = text.match(/\((\d+)\)/);
  const hints = {
    15: 'The other account cannot trade with you (privacy settings or not friends).',
    16: 'Steam timed out while processing the trade - it may still have gone through.',
    20: 'Steam is having trouble reaching the item servers. Try again shortly.',
    25: 'Too many trade offers are already open with this account.',
    26: 'One of the items is no longer in the inventory.',
    28: 'This trade offer was already accepted or cancelled.',
  };
  const hint = codeMatch ? hints[Number(codeMatch[1])] : null;
  const cleaned = text.replace(/\s*\(\d+\)\s*$/, '').trim();
  return hint ? `${cleaned}. ${hint}` : cleaned;
}
