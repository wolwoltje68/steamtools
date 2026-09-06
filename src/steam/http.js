// HTTP layer for Steam.
//
// React Native's fetch is backed by a single process-wide native cookie jar. If
// we relied on it, logging a second account in would silently clobber the first
// one's session. So every request goes out with `credentials: 'omit'` and an
// explicitly built Cookie header derived from the account's own tokens, which
// keeps accounts fully isolated and makes parallel multi-account polling safe.
import { randomHex } from '../lib/random.js';

export const COMMUNITY = 'https://steamcommunity.com';
export const API = 'https://api.steampowered.com';
export const STORE = 'https://store.steampowered.com';

// Presenting as the Steam mobile app; /mobileconf/ rejects other clients.
const MOBILE_UA =
  'Mozilla/5.0 (Linux; U; Android 12; en-us; SM-G991B Build/SP1A.210812.016) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/104.0.5112.97 Mobile Safari/605.1.15';
const MOBILE_CLIENT_VERSION = '777777 3.6.2';

export class SteamHttpError extends Error {
  constructor(message, { status, eresult, body, url } = {}) {
    super(message);
    this.name = 'SteamHttpError';
    this.status = status;
    this.eresult = eresult;
    this.body = body;
    this.url = url;
  }
}

/** Steam echoes its result code in this header on WebAPI responses. */
export const EResult = {
  OK: 1,
  Fail: 2,
  InvalidPassword: 5,
  AccessDenied: 15,
  Timeout: 16,
  RateLimitExceeded: 84,
  TwoFactorCodeMismatch: 88,
  Expired: 27,
  Busy: 10,
  Pending: 22,
};

export function newSessionId() {
  return randomHex(12); // Steam uses a 24-character hex sessionid
}

/**
 * Cookie header for an account. `steamLoginSecure` is the modern Steam session
 * cookie: the 64-bit steamid, a literal "||" (percent-encoded, exactly as Steam
 * itself sets it) and the JWT access token.
 */
export function buildCookieHeader(account, { mobile = false } = {}) {
  const cookies = [`sessionid=${account.sessionId || ''}`, 'Steam_Language=english', 'timezoneOffset=0,0'];

  if (account.steamId && account.accessToken) {
    cookies.push(`steamLoginSecure=${account.steamId}%7C%7C${encodeURIComponent(account.accessToken)}`);
  }
  if (mobile) {
    cookies.push(`mobileClientVersion=${encodeURIComponent(MOBILE_CLIENT_VERSION)}`);
    cookies.push('mobileClient=android');
    if (account.steamId) cookies.push(`steamid=${account.steamId}`);
  }
  return cookies.filter((c) => !c.endsWith('=')).join('; ');
}

export function encodeForm(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

export function withQuery(url, params) {
  const query = encodeForm(params || {});
  if (!query) return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}

/**
 * Perform a Steam request.
 *
 * @param {object|null} account  account providing session cookies, or null
 * @param {string} url
 * @param {object} options
 * @param {'GET'|'POST'} [options.method]
 * @param {object} [options.form]     urlencoded body
 * @param {object} [options.query]
 * @param {string} [options.referer]
 * @param {boolean} [options.mobile]  send mobile-app cookies and user agent
 * @param {'json'|'text'|'none'} [options.expect]
 * @param {number} [options.timeoutMs]
 */
export async function steamRequest(account, url, options = {}) {
  const {
    method = 'GET',
    form,
    query,
    referer,
    mobile = false,
    expect = 'json',
    timeoutMs = 30000,
    headers: extraHeaders = {},
  } = options;

  const target = withQuery(url, query);
  const headers = {
    Accept: expect === 'json' ? 'application/json, text/plain, */*' : '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': mobile ? MOBILE_UA : 'Mozilla/5.0 (Linux; Android 12) SteamTools/1.0',
    ...extraHeaders,
  };

  const cookie = account ? buildCookieHeader(account, { mobile }) : '';
  if (cookie) headers.Cookie = cookie;
  if (referer) headers.Referer = referer;
  if (mobile) headers['X-Requested-With'] = 'com.valvesoftware.android.steam.community';

  let body;
  if (form) {
    body = encodeForm(form);
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(target, { method, headers, body, credentials: 'omit', signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new SteamHttpError('Request to Steam timed out', { url: target });
    }
    throw new SteamHttpError(`Could not reach Steam: ${err.message}`, { url: target });
  }
  clearTimeout(timer);

  const eresultHeader = response.headers.get('x-eresult');
  const eresult = eresultHeader ? Number(eresultHeader) : undefined;

  if (expect === 'none') {
    assertOk(response, eresult, '', target);
    return { response, eresult };
  }

  const text = await response.text();
  assertOk(response, eresult, text, target);

  if (expect === 'text') return { response, eresult, text };

  if (!text) return { response, eresult, data: null };
  try {
    return { response, eresult, data: JSON.parse(text) };
  } catch (err) {
    // A login page or Cloudflare interstitial instead of JSON almost always
    // means the session expired.
    if (/<\s*html/i.test(text)) {
      throw new SteamHttpError('Steam returned a web page instead of data - the session is probably expired', {
        status: response.status,
        eresult,
        body: text.slice(0, 400),
        url: target,
      });
    }
    throw new SteamHttpError(`Could not parse Steam's response as JSON: ${err.message}`, {
      status: response.status,
      eresult,
      body: text.slice(0, 400),
      url: target,
    });
  }
}

function assertOk(response, eresult, text, url) {
  if (response.ok) return;
  const messages = {
    401: 'Steam rejected the session (401) - sign in again',
    403: 'Steam denied access (403) - the session may be expired or the account is limited',
    429: 'Steam is rate limiting this account (429) - slow down and try again later',
  };
  throw new SteamHttpError(messages[response.status] || `Steam returned HTTP ${response.status}`, {
    status: response.status,
    eresult,
    body: typeof text === 'string' ? text.slice(0, 400) : undefined,
    url,
  });
}

/** True when the failure means "your session died", so callers can re-auth. */
export function isSessionExpired(error) {
  if (!(error instanceof SteamHttpError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  if (error.eresult === EResult.AccessDenied || error.eresult === EResult.Expired) return true;
  return /session is probably expired/.test(error.message);
}
