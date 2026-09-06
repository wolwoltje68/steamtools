// Steam mobile confirmations: the /mobileconf/ endpoints the Steam app uses to
// approve trades, market listings and account changes.
import { COMMUNITY, SteamHttpError, steamRequest } from './http.js';
import { getConfirmationKey, getDeviceId } from './guard.js';
import { steamUnixTime, syncSteamTime } from './time.js';

/** EConfirmationType */
export const ConfirmationType = {
  Test: 1,
  Trade: 2,
  MarketListing: 3,
  FeatureOptOut: 4,
  PhoneNumberChange: 5,
  AccountRecovery: 6,
  ApiKey: 9,
};

export function describeConfirmationType(type) {
  switch (Number(type)) {
    case ConfirmationType.Trade:
      return 'Trade offer';
    case ConfirmationType.MarketListing:
      return 'Market listing';
    case ConfirmationType.PhoneNumberChange:
      return 'Phone number change';
    case ConfirmationType.AccountRecovery:
      return 'Account recovery';
    case ConfirmationType.ApiKey:
      return 'API key';
    default:
      return 'Confirmation';
  }
}

function requireSecrets(account) {
  if (!account.identitySecret) {
    throw new SteamHttpError(`No identity_secret stored for ${account.accountName} - confirmations are unavailable`);
  }
  if (!account.steamId) {
    throw new SteamHttpError(`No steamId stored for ${account.accountName}`);
  }
}

function signedParams(account, tag) {
  const time = steamUnixTime();
  return {
    p: account.deviceId || getDeviceId(account.steamId),
    a: account.steamId,
    k: getConfirmationKey(account.identitySecret, tag, time),
    t: time,
    m: 'react',
    tag,
  };
}

/** Fetch every pending confirmation for the account. */
export async function fetchConfirmations(account) {
  requireSecrets(account);
  await syncSteamTime().catch(() => {});

  const { data } = await steamRequest(account, `${COMMUNITY}/mobileconf/getlist`, {
    query: signedParams(account, 'conf'),
    mobile: true,
    referer: `${COMMUNITY}/mobileconf/conf`,
  });

  if (!data || data.success !== true) {
    if (data?.needauth || data?.needsauth) {
      throw new SteamHttpError('Steam wants a fresh sign-in before showing confirmations', { status: 401 });
    }
    throw new SteamHttpError(data?.message || 'Steam refused to list confirmations');
  }

  return (data.conf || []).map((conf) => ({
    id: String(conf.id),
    nonce: String(conf.nonce),
    creatorId: String(conf.creator_id),
    type: Number(conf.type),
    typeName: conf.type_name || describeConfirmationType(conf.type),
    headline: conf.headline || '',
    summary: Array.isArray(conf.summary) ? conf.summary : [],
    icon: conf.icon || null,
    creationTime: Number(conf.creation_time) || 0,
    acceptLabel: conf.accept || 'Accept',
    cancelLabel: conf.cancel || 'Cancel',
    warn: conf.warn || null,
    multi: !!conf.multi,
  }));
}

/** Accept or reject a single confirmation. */
export async function respondToConfirmation(account, confirmation, accept) {
  requireSecrets(account);
  const tag = accept ? 'allow' : 'cancel';

  const { data } = await steamRequest(account, `${COMMUNITY}/mobileconf/ajaxop`, {
    query: {
      op: tag,
      ...signedParams(account, tag),
      cid: confirmation.id,
      ck: confirmation.nonce,
    },
    mobile: true,
    referer: `${COMMUNITY}/mobileconf/conf`,
  });

  if (!data || data.success !== true) {
    throw new SteamHttpError(data?.message || `Steam refused to ${accept ? 'accept' : 'cancel'} the confirmation`);
  }
  return true;
}

/** Accept or reject several confirmations in one request. */
export async function respondToConfirmations(account, confirmations, accept) {
  if (confirmations.length === 0) return true;
  if (confirmations.length === 1) return respondToConfirmation(account, confirmations[0], accept);
  requireSecrets(account);

  const tag = accept ? 'allow' : 'cancel';
  const { data } = await steamRequest(account, `${COMMUNITY}/mobileconf/multiajaxop`, {
    method: 'POST',
    form: {
      op: tag,
      ...signedParams(account, tag),
      'cid[]': confirmations.map((c) => c.id),
      'ck[]': confirmations.map((c) => c.nonce),
    },
    mobile: true,
    referer: `${COMMUNITY}/mobileconf/conf`,
  });

  if (!data || data.success !== true) {
    throw new SteamHttpError(data?.message || 'Steam refused the bulk confirmation');
  }
  return true;
}

/**
 * Which confirmations an automation rule set should act on.
 * Deliberately conservative: account-level confirmations (phone number changes,
 * account recovery, API keys) are never auto-approved.
 */
export function selectAutoConfirmable(confirmations, rules) {
  return confirmations.filter((conf) => {
    if (conf.type === ConfirmationType.Trade) return !!rules.autoConfirmTrades;
    if (conf.type === ConfirmationType.MarketListing) return !!rules.autoConfirmMarket;
    return false;
  });
}
