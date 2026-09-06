// Steam Community Market: price lookups and creating sell listings.
import { COMMUNITY, SteamHttpError, steamRequest } from './http.js';

/** Currency ids Steam uses on market endpoints. */
export const CURRENCIES = [
  { id: 1, code: 'USD', symbol: '$' },
  { id: 2, code: 'GBP', symbol: '£' },
  { id: 3, code: 'EUR', symbol: '€' },
  { id: 5, code: 'RUB', symbol: '₽' },
  { id: 6, code: 'PLN', symbol: 'zł' },
  { id: 7, code: 'BRL', symbol: 'R$' },
  { id: 9, code: 'NOK', symbol: 'kr' },
  { id: 20, code: 'UAH', symbol: '₴' },
  { id: 23, code: 'SEK', symbol: 'kr' },
  { id: 24, code: 'AUD', symbol: 'A$' },
];

export function currencyById(id) {
  return CURRENCIES.find((c) => c.id === Number(id)) || CURRENCIES[2];
}

const DEFAULT_PUBLISHER_FEE = 0.1;
const STEAM_FEE = 0.05;
const MIN_FEE_CENTS = 1;

/**
 * Steam charges the buyer on top of what the seller asks. Mirrors the
 * CalculateAmountToSendForDesiredReceivedAmount logic from Steam's own market
 * JavaScript; treat the result as an estimate, since the publisher fee varies
 * per game.
 *
 * @param {number} receivedCents what the seller wants to receive
 * @returns {{receives: number, steamFee: number, publisherFee: number, buyerPays: number}}
 */
export function estimateFees(receivedCents, publisherFeeRate = DEFAULT_PUBLISHER_FEE) {
  const received = Math.max(0, Math.round(receivedCents));
  if (received === 0) return { receives: 0, steamFee: 0, publisherFee: 0, buyerPays: 0 };

  const steamFee = Math.max(Math.floor(received * STEAM_FEE), MIN_FEE_CENTS);
  const publisherFee = publisherFeeRate > 0
    ? Math.max(Math.floor(received * publisherFeeRate), MIN_FEE_CENTS)
    : 0;

  return { receives: received, steamFee, publisherFee, buyerPays: received + steamFee + publisherFee };
}

/** Inverse of estimateFees: what the seller keeps when the buyer pays this. */
export function receivedFromBuyerPays(buyerPaysCents, publisherFeeRate = DEFAULT_PUBLISHER_FEE) {
  let guess = Math.floor(buyerPaysCents / (1 + STEAM_FEE + publisherFeeRate));
  for (let i = 0; i < 16; i++) {
    const { buyerPays } = estimateFees(guess, publisherFeeRate);
    if (buyerPays === buyerPaysCents) return guess;
    guess += buyerPays < buyerPaysCents ? 1 : -1;
    if (guess < 0) return 0;
  }
  return Math.max(0, guess);
}

export function formatPrice(cents, currency) {
  const { symbol } = currencyById(currency);
  return `${symbol}${(Math.round(cents) / 100).toFixed(2)}`;
}

/** Parse "€1.234,56" / "$12.34" / "1,23 zł" into integer cents. */
export function parsePriceToCents(text) {
  if (typeof text === 'number') return Math.round(text * 100);
  const digits = String(text || '').replace(/[^0-9.,]/g, '');
  if (!digits) return 0;

  // The last separator is the decimal one when it is followed by 1-2 digits.
  const match = digits.match(/^(.*)([.,])(\d{1,2})$/);
  if (match) {
    const whole = match[1].replace(/[.,]/g, '');
    return Number(whole || '0') * 100 + Number(match[3].padEnd(2, '0'));
  }
  return Number(digits.replace(/[.,]/g, '')) * 100;
}

/** Current lowest price / median for a market item. */
export async function getPriceOverview(account, { appid, marketHashName, currency = 3 }) {
  const { data } = await steamRequest(account, `${COMMUNITY}/market/priceoverview/`, {
    query: { appid: String(appid), currency: String(currency), market_hash_name: marketHashName },
    referer: `${COMMUNITY}/market/`,
  });

  if (!data || data.success !== true) {
    throw new SteamHttpError('Steam has no price data for this item (it may not be sold on the market)');
  }
  return {
    lowestPriceCents: data.lowest_price ? parsePriceToCents(data.lowest_price) : null,
    medianPriceCents: data.median_price ? parsePriceToCents(data.median_price) : null,
    volume: data.volume ? Number(String(data.volume).replace(/[^\d]/g, '')) : 0,
    currency,
  };
}

/**
 * Create a sell listing. The `price` Steam wants is the amount the seller
 * receives, in cents. Almost every listing then needs a mobile confirmation.
 */
export async function createSellListing(account, { appid, contextid, assetid, amount = 1, receivesCents }) {
  if (!account.accessToken) throw new SteamHttpError(`${account.accountName} is not signed in`, { status: 401 });
  if (!Number.isFinite(receivesCents) || receivesCents < 1) throw new Error('Enter a price of at least 0.01');

  const { data } = await steamRequest(account, `${COMMUNITY}/market/sellitem/`, {
    method: 'POST',
    form: {
      sessionid: account.sessionId,
      appid: String(appid),
      contextid: String(contextid),
      assetid: String(assetid),
      amount: String(amount),
      price: String(Math.round(receivesCents)),
    },
    referer: `${COMMUNITY}/profiles/${account.steamId}/inventory`,
    headers: { Origin: COMMUNITY },
  });

  if (!data || data.success !== true) {
    throw new SteamHttpError(data?.message || 'Steam refused to create the listing');
  }
  return {
    needsConfirmation: !!(data.requires_confirmation || data.needs_mobile_confirmation),
    needsEmailConfirmation: !!data.needs_email_confirmation,
  };
}

/** Listings this account currently has up for sale. */
export async function getMyListings(account) {
  const { data } = await steamRequest(account, `${COMMUNITY}/market/mylistings`, {
    query: { norender: '1', count: '100' },
    referer: `${COMMUNITY}/market/`,
  });
  if (!data || data.success !== true) throw new SteamHttpError('Could not load your market listings');

  const assets = data.assets || {};
  return (data.listings || []).map((listing) => {
    const asset = assets?.[listing.asset?.appid]?.[listing.asset?.contextid]?.[listing.asset?.id];
    return {
      listingId: String(listing.listingid),
      appid: Number(listing.asset?.appid),
      assetid: String(listing.asset?.id || ''),
      name: asset?.market_name || asset?.name || listing.asset?.market_hash_name || 'Listing',
      iconUrl: asset?.icon_url || null,
      buyerPaysCents: Number(listing.price) + Number(listing.fee || 0),
      receivesCents: Number(listing.price),
      currency: Number(listing.currencyid) - 2000,
      active: listing.active === 1,
    };
  });
}

export async function removeListing(account, listingId) {
  await steamRequest(account, `${COMMUNITY}/market/removelisting/${listingId}`, {
    method: 'POST',
    form: { sessionid: account.sessionId },
    referer: `${COMMUNITY}/market/`,
    expect: 'text',
  });
  return true;
}
