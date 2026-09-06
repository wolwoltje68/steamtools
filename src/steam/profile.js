// Resolving whatever a user pastes into a SteamID64.
//
// Steam exposes a profile as XML at /?xml=1, which needs no API key, so a
// vanity name like "b4nny" can be resolved without registering for one.
import { COMMUNITY, SteamHttpError, steamRequest } from './http.js';
import { isValidSteamId64 } from './steamid.js';

export class ProfileError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

/**
 * Work out what the user pasted.
 *
 * Accepts a bare SteamID64, a bare vanity name, or any of the profile and
 * inventory URL shapes Steam uses. An inventory URL may carry the game in its
 * fragment (`#730_2`), which is worth keeping.
 *
 * @returns {{kind: 'steamid64'|'vanity', value: string, appid?: number, contextid?: string}}
 */
export function parseProfileInput(input) {
  const text = String(input || '').trim();
  if (!text) throw new ProfileError('Enter a SteamID, profile URL or custom URL name');

  // #730_2 at the end of an inventory link selects the game and context.
  let appid;
  let contextid;
  const fragment = text.match(/#(\d+)_(\d+)$/);
  if (fragment) {
    appid = Number(fragment[1]);
    contextid = fragment[2];
  }
  const withoutFragment = text.replace(/#.*$/, '');

  const profileUrl = withoutFragment.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (profileUrl) return { kind: 'steamid64', value: profileUrl[1], appid, contextid };

  const vanityUrl = withoutFragment.match(/steamcommunity\.com\/id\/([^/?#\s]+)/i);
  if (vanityUrl) return { kind: 'vanity', value: decodeURIComponent(vanityUrl[1]), appid, contextid };

  const bare = withoutFragment.replace(/\/+$/, '').trim();
  if (isValidSteamId64(bare)) return { kind: 'steamid64', value: bare, appid, contextid };

  if (/^\d+$/.test(bare)) {
    throw new ProfileError('That looks like a number but is not a valid SteamID64 (17 digits)');
  }
  if (/^[a-zA-Z0-9_-]{2,32}$/.test(bare)) return { kind: 'vanity', value: bare, appid, contextid };

  throw new ProfileError('Could not read that as a SteamID, profile URL or custom URL name');
}

/** Read one element out of Steam's profile XML, unwrapping CDATA. */
function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

/**
 * Resolve a vanity name to a SteamID64 and pick up the display name.
 *
 * @param {object|null} account used only for cookies; public profiles resolve
 *   fine without a session, so null is allowed.
 */
export async function resolveVanityName(account, vanityName) {
  const { text } = await steamRequest(account, `${COMMUNITY}/id/${encodeURIComponent(vanityName)}/`, {
    query: { xml: '1' },
    expect: 'text',
  });

  const error = xmlValue(text, 'error');
  if (error) throw new ProfileError(`Steam could not find "${vanityName}": ${error}`, { code: 'NOT_FOUND' });

  const steamId = xmlValue(text, 'steamID64');
  if (!steamId || !isValidSteamId64(steamId)) {
    throw new ProfileError(`Steam did not return a SteamID for "${vanityName}"`, { code: 'NOT_FOUND' });
  }

  return {
    steamId,
    displayName: xmlValue(text, 'steamID') || vanityName,
    avatar: xmlValue(text, 'avatarMedium'),
    privacy: xmlValue(text, 'privacyState'),
  };
}

/** Look up a display name for a SteamID64 we already have. */
export async function fetchProfileSummary(account, steamId) {
  try {
    const { text } = await steamRequest(account, `${COMMUNITY}/profiles/${steamId}/`, {
      query: { xml: '1' },
      expect: 'text',
    });
    return {
      steamId,
      displayName: xmlValue(text, 'steamID') || steamId,
      avatar: xmlValue(text, 'avatarMedium'),
      privacy: xmlValue(text, 'privacyState'),
    };
  } catch (err) {
    // A missing display name must never block browsing the inventory.
    return { steamId, displayName: steamId, avatar: null, privacy: null };
  }
}

/**
 * Resolve anything the user pasted into a profile.
 * @returns {Promise<{steamId, displayName, avatar, privacy, appid?, contextid?}>}
 */
export async function resolveProfile(account, input) {
  const parsed = parseProfileInput(input);
  const base = parsed.kind === 'steamid64'
    ? await fetchProfileSummary(account, parsed.value)
    : await resolveVanityName(account, parsed.value);

  if (!(base.steamId && isValidSteamId64(base.steamId))) {
    throw new SteamHttpError('Steam returned an unusable SteamID');
  }
  return { ...base, appid: parsed.appid, contextid: parsed.contextid };
}
