// Steam login via IAuthenticationService (the flow the website and mobile app
// use since 2023) plus access-token renewal.
//
// The resulting access_token doubles as the web session: the steamLoginSecure
// cookie is literally `<steamid>||<access_token>`, so no separate
// /jwt/finalizelogin transfer round-trip is needed.
import { API, EResult, SteamHttpError, newSessionId, steamRequest } from './http.js';
import { base64ToBytes, bytesToBase64, bytesToUtf8, utf8ToBytes } from '../lib/bytes.js';
import { rsaEncryptPkcs1 } from '../lib/rsa.js';
import { generateAuthCode } from './guard.js';
import { steamUnixTime, syncSteamTime } from './time.js';

/** EAuthSessionGuardType */
export const GuardType = {
  None: 0,
  EmailCode: 1,
  DeviceCode: 2,
  DeviceConfirmation: 3,
  EmailConfirmation: 4,
  MachineToken: 5,
};

const WEBSITE_ID = 'Community';
const PLATFORM_WEB_BROWSER = 2;

export class SteamLoginError extends Error {
  constructor(message, { eresult, code } = {}) {
    super(message);
    this.name = 'SteamLoginError';
    this.eresult = eresult;
    this.code = code;
  }
}

async function authService(method, form, { httpMethod = 'POST' } = {}) {
  return steamRequest(null, `${API}/IAuthenticationService/${method}/v1/`, {
    method: httpMethod,
    ...(httpMethod === 'POST' ? { form } : { query: form }),
  });
}

/** Decode the `exp` claim so we know when to renew, without any JWT library. */
export function decodeJwtExpiry(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return 0;
    const json = bytesToUtf8(base64ToBytes(payload));
    const exp = Number(JSON.parse(json).exp);
    return Number.isFinite(exp) ? exp : 0;
  } catch (err) {
    return 0;
  }
}

async function encryptPassword(accountName, password) {
  const { data } = await authService('GetPasswordRSAPublicKey', { account_name: accountName }, { httpMethod: 'GET' });
  const key = data?.response;
  if (!key?.publickey_mod || !key?.publickey_exp) {
    throw new SteamLoginError(`Steam did not return a public key for "${accountName}" - check the account name`);
  }
  return {
    encryptedPassword: bytesToBase64(
      rsaEncryptPkcs1(key.publickey_mod, key.publickey_exp, utf8ToBytes(password))
    ),
    timestamp: key.timestamp,
  };
}

/**
 * Full credential login. When `sharedSecret` is supplied the Guard code is
 * generated and submitted automatically, so the whole thing is unattended.
 *
 * @returns {Promise<{steamId: string, accountName: string, refreshToken: string,
 *   accessToken: string, accessTokenExpires: number, sessionId: string}>}
 */
export async function login({ accountName, password, sharedSecret, onGuardRequired, deviceName = 'SteamTools' }) {
  if (!accountName) throw new SteamLoginError('An account name is required');
  if (!password) throw new SteamLoginError('A password is required');

  await syncSteamTime().catch(() => {}); // best effort; local clock is the fallback

  const { encryptedPassword, timestamp } = await encryptPassword(accountName, password);

  const begin = await authService('BeginAuthSessionViaCredentials', {
    account_name: accountName,
    encrypted_password: encryptedPassword,
    encryption_timestamp: timestamp,
    remember_login: 'true',
    persistence: '1',
    website_id: WEBSITE_ID,
    platform_type: String(PLATFORM_WEB_BROWSER),
    device_friendly_name: deviceName,
  });

  if (begin.eresult === EResult.InvalidPassword) {
    throw new SteamLoginError('Steam rejected the account name or password', { eresult: begin.eresult });
  }
  if (begin.eresult === EResult.RateLimitExceeded) {
    throw new SteamLoginError('Too many login attempts - Steam is rate limiting this account. Wait a while.', {
      eresult: begin.eresult,
    });
  }

  const session = begin.data?.response;
  if (!session?.client_id || !session?.steamid) {
    throw new SteamLoginError('Steam rejected the account name or password', { eresult: begin.eresult });
  }

  const guardTypes = (session.allowed_confirmations || []).map((c) => Number(c.confirmation_type));
  const needsDeviceCode = guardTypes.includes(GuardType.DeviceCode);
  const needsEmailCode = guardTypes.includes(GuardType.EmailCode);
  const needsApproval = guardTypes.includes(GuardType.DeviceConfirmation) || guardTypes.includes(GuardType.EmailConfirmation);

  if (needsDeviceCode || needsEmailCode) {
    let code;
    if (needsDeviceCode && sharedSecret) {
      code = generateAuthCode(sharedSecret, steamUnixTime());
    } else if (onGuardRequired) {
      code = await onGuardRequired({
        type: needsDeviceCode ? GuardType.DeviceCode : GuardType.EmailCode,
        message: session.allowed_confirmations?.[0]?.associated_message,
      });
    }
    if (!code) {
      throw new SteamLoginError(
        needsDeviceCode
          ? 'This account needs a Steam Guard code and no shared_secret is stored for it'
          : 'This account needs the Steam Guard code that was emailed to you',
        { code: 'GUARD_REQUIRED' }
      );
    }

    const update = await authService('UpdateAuthSessionWithSteamGuardCode', {
      client_id: session.client_id,
      steamid: session.steamid,
      code,
      code_type: String(needsDeviceCode ? GuardType.DeviceCode : GuardType.EmailCode),
    });
    if (update.eresult === EResult.TwoFactorCodeMismatch) {
      throw new SteamLoginError(
        'Steam rejected the Guard code. If this keeps happening the phone clock is likely out of sync.',
        { eresult: update.eresult }
      );
    }
  } else if (needsApproval) {
    throw new SteamLoginError(
      'This account requires approval in the Steam mobile app. Approve the login there, then try again.',
      { code: 'APPROVAL_REQUIRED' }
    );
  }

  const tokens = await pollForTokens(session.client_id, session.request_id, Number(session.interval) || 5);

  const accessToken = tokens.access_token || '';
  return {
    steamId: String(session.steamid),
    accountName: tokens.account_name || accountName,
    refreshToken: tokens.refresh_token || '',
    accessToken,
    accessTokenExpires: decodeJwtExpiry(accessToken),
    sessionId: newSessionId(),
  };
}

async function pollForTokens(clientId, requestId, intervalSeconds) {
  const deadline = Date.now() + 90 * 1000;
  let delay = Math.max(1, Math.min(intervalSeconds, 5)) * 1000;

  while (Date.now() < deadline) {
    const { data, eresult } = await authService('PollAuthSessionStatus', {
      client_id: clientId,
      request_id: requestId,
    });
    const response = data?.response || {};
    if (response.refresh_token && response.access_token) return response;
    if (eresult === EResult.Expired || response.had_remote_interaction === false) {
      // keep waiting; `had_remote_interaction:false` just means nothing yet
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
  }
  throw new SteamLoginError('Timed out waiting for Steam to complete the sign-in');
}

/**
 * Exchange the long-lived refresh token for a fresh access token. Access tokens
 * live ~24h, refresh tokens ~200 days.
 */
export async function renewAccessToken(account) {
  if (!account.refreshToken) {
    throw new SteamLoginError('No refresh token stored - sign in again', { code: 'NO_REFRESH_TOKEN' });
  }
  const { data } = await authService('GenerateAccessTokenForApp', {
    refresh_token: account.refreshToken,
    steamid: account.steamId,
  });
  const accessToken = data?.response?.access_token;
  if (!accessToken) {
    throw new SteamLoginError('Steam refused to renew the session - sign in again', { code: 'REFRESH_FAILED' });
  }
  return { accessToken, accessTokenExpires: decodeJwtExpiry(accessToken) };
}

/** True when the token is missing or expires within the next 10 minutes. */
export function needsRenewal(account) {
  if (!account.accessToken) return true;
  if (!account.accessTokenExpires) return false;
  return account.accessTokenExpires - 600 <= Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { SteamHttpError };
