// maFile import/export.
//
// The on-disk format stays compatible with SteamDesktopAuthenticator (SDA) so
// files move both ways, with two additions of our own: `password` (the Steam
// account password, when the user chose to store it) and the modern
// refresh/access tokens inside `Session`.
import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  bytesEqual,
  utf8ToBytes,
} from '../lib/bytes.js';
import { aesCbcDecrypt, aesCbcEncrypt, hmacSha256, pbkdf2Sha1, pbkdf2Sha256 } from '../lib/crypto.js';
import { randomBytes, randomUuid } from '../lib/random.js';
import { getDeviceId } from './guard.js';
import { isValidSteamId64 } from './steamid.js';

export const EXPORT_MAGIC = 'steamtools-vault';
export const EXPORT_VERSION = 1;
const EXPORT_ITERATIONS = 150000;

// SDA's own encryption parameters, needed to read its encrypted maFiles.
const SDA_ITERATIONS = 50000;
const SDA_KEY_SIZE = 32;

export class MaFileError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'MaFileError';
    this.code = code;
  }
}

/**
 * SteamIDs are 17-digit integers, larger than Number.MAX_SAFE_INTEGER. SDA
 * writes them unquoted, so a plain JSON.parse silently rounds them
 * (76561198000000000 -> 76561198000000000 is fine, but many are not). Quote
 * every long integer under a steamid-ish key before parsing.
 */
export function parseJsonPreservingSteamIds(text) {
  const guarded = text.replace(
    /("(?:SteamID|steamid|steamId|SteamId|creator_id|assetid|classid|instanceid)"\s*:\s*)(\d{10,})/g,
    '$1"$2"'
  );
  return JSON.parse(guarded);
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (candidate === 0) continue;
    if (candidate !== undefined && candidate !== null && String(candidate).length > 0) {
      return String(candidate);
    }
  }
  return '';
}

/** Pull the steamid out of the otpauth:// URI as a last resort. */
function steamIdFromUri(uri) {
  const match = String(uri || '').match(/(\d{17})/);
  return match ? match[1] : '';
}

/**
 * Turn a parsed maFile object into the account shape the app uses.
 * @param {object} raw
 * @param {{sourceName?: string}} options
 */
export function normaliseMaFile(raw, { sourceName } = {}) {
  if (!raw || typeof raw !== 'object') throw new MaFileError('That file does not contain a maFile object');

  const session = raw.Session || raw.session || {};
  const sharedSecret = firstString(raw.shared_secret, raw.sharedSecret);
  const identitySecret = firstString(raw.identity_secret, raw.identitySecret);

  if (!sharedSecret) {
    throw new MaFileError('This maFile has no shared_secret, so it cannot generate Steam Guard codes', {
      code: 'NO_SHARED_SECRET',
    });
  }

  const steamId = firstString(
    raw.steamid,
    raw.SteamID,
    session.SteamID,
    session.steamid,
    steamIdFromUri(raw.uri)
  );

  const accountName = firstString(raw.account_name, raw.accountName, sourceName, 'unknown');

  return {
    id: randomUuid(),
    accountName,
    steamId,
    sharedSecret,
    identitySecret,
    revocationCode: firstString(raw.revocation_code, raw.revocationCode),
    serialNumber: firstString(raw.serial_number),
    tokenGid: firstString(raw.token_gid),
    secret1: firstString(raw.secret_1),
    uri: firstString(raw.uri),
    status: Number(raw.status) || 1,
    fullyEnrolled: raw.fully_enrolled !== false,
    deviceId: firstString(raw.device_id, raw.deviceId) || (steamId ? getDeviceId(steamId) : ''),

    // Our extensions.
    password: firstString(raw.password, raw.Password) || null,

    // Live session state; never trusted from an import, only carried forward.
    sessionId: firstString(session.SessionID, session.sessionid) || null,
    refreshToken: firstString(session.RefreshToken, raw.refresh_token) || null,
    accessToken: firstString(session.AccessToken, raw.access_token) || null,
    accessTokenExpires: Number(session.AccessTokenExpires) || 0,

    automation: normaliseAutomation(raw.automation),
    addedAt: Number(raw.added_at) || Math.floor(Date.now() / 1000),
  };
}

export const DEFAULT_AUTOMATION = {
  enabled: false,
  intervalSeconds: 60,
  confirmTrades: false,
  confirmMarket: false,
  acceptGiftOffers: false,
  acceptFromTrusted: false,
  trustedSteamIds: [],
  declineOthers: false,
  notify: true,
};

export function normaliseAutomation(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULT_AUTOMATION,
    ...source,
    intervalSeconds: Math.max(30, Number(source.intervalSeconds) || DEFAULT_AUTOMATION.intervalSeconds),
    trustedSteamIds: Array.isArray(source.trustedSteamIds)
      ? source.trustedSteamIds.map(String).filter(isValidSteamId64)
      : [],
  };
}

/** Parse the text of a single .maFile. */
export function parseMaFileText(text, options = {}) {
  let raw;
  try {
    raw = parseJsonPreservingSteamIds(text);
  } catch (err) {
    if (looksLikeSdaEncrypted(text)) {
      throw new MaFileError(
        'This maFile is encrypted by SteamDesktopAuthenticator. Import its manifest.json together with it so the salt and IV can be read.',
        { code: 'SDA_ENCRYPTED' }
      );
    }
    throw new MaFileError('That file is not valid JSON');
  }
  return normaliseMaFile(raw, options);
}

/** SDA writes the ciphertext as bare base64 with no JSON structure. */
export function looksLikeSdaEncrypted(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length > 32 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed) && !trimmed.startsWith('{');
}

/** Decrypt an SDA maFile using the salt and IV from its manifest.json entry. */
export function decryptSdaMaFile(cipherBase64, passkey, saltBase64, ivBase64) {
  const key = pbkdf2Sha1(passkey, base64ToBytes(saltBase64), SDA_ITERATIONS, SDA_KEY_SIZE);
  try {
    const plaintext = aesCbcDecrypt(key, base64ToBytes(ivBase64), base64ToBytes(cipherBase64));
    return bytesToUtf8(plaintext);
  } catch (err) {
    throw new MaFileError('Wrong password for this SteamDesktopAuthenticator file', { code: 'BAD_PASSWORD' });
  }
}

/**
 * Build the maFile representation of an account.
 * @param {object} account
 * @param {{includePassword?: boolean, includeSession?: boolean}} options
 */
export function accountToMaFile(account, { includePassword = true, includeSession = true } = {}) {
  const maFile = {
    shared_secret: account.sharedSecret,
    serial_number: account.serialNumber || '',
    revocation_code: account.revocationCode || '',
    uri: account.uri || '',
    server_time: Math.floor(Date.now() / 1000),
    account_name: account.accountName,
    token_gid: account.tokenGid || '',
    identity_secret: account.identitySecret || '',
    secret_1: account.secret1 || '',
    status: account.status || 1,
    device_id: account.deviceId || (account.steamId ? getDeviceId(account.steamId) : ''),
    fully_enrolled: account.fullyEnrolled !== false,
    Session: {
      SessionID: includeSession ? account.sessionId || '' : '',
      SteamLogin: '',
      SteamLoginSecure: '',
      WebCookie: '',
      OAuthToken: '',
      SteamID: account.steamId || '0',
      RefreshToken: includeSession ? account.refreshToken || '' : '',
      AccessToken: includeSession ? account.accessToken || '' : '',
      AccessTokenExpires: includeSession ? account.accessTokenExpires || 0 : 0,
    },
    automation: account.automation || DEFAULT_AUTOMATION,
    added_at: account.addedAt || Math.floor(Date.now() / 1000),
  };

  // The user asked for the password to travel with the maFile when there is one.
  if (includePassword && account.password) maFile.password = account.password;
  return maFile;
}

/**
 * Serialise a maFile. SteamID is emitted as an unquoted integer so SDA and
 * other tools parse it the way they expect.
 */
export function serialiseMaFile(maFile) {
  const placeholder = '@@STEAMID@@';
  const steamId = String(maFile.Session?.SteamID || '0');
  const clone = { ...maFile, Session: { ...maFile.Session, SteamID: placeholder } };
  return JSON.stringify(clone, null, 2).replace(`"${placeholder}"`, steamId);
}

/**
 * Encrypted export bundle.
 *
 * AES-256-CBC with an encrypt-then-MAC HMAC-SHA256 tag, both keys derived from
 * one PBKDF2-SHA256 pass. The MAC means a wrong password or a tampered file is
 * reported as such instead of yielding garbage plaintext.
 */
export function encryptExport(accounts, passkey, { includePasswords = true, iterations = EXPORT_ITERATIONS } = {}) {
  if (!passkey) throw new MaFileError('An export password is required');

  const payload = {
    magic: EXPORT_MAGIC,
    version: EXPORT_VERSION,
    exported_at: Math.floor(Date.now() / 1000),
    accounts: accounts.map((account) =>
      accountToMaFile(account, { includePassword: includePasswords, includeSession: false })
    ),
  };

  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const derived = pbkdf2Sha256(passkey, salt, iterations, 64);
  const encryptionKey = derived.slice(0, 32);
  const macKey = derived.slice(32);

  const ciphertext = aesCbcEncrypt(encryptionKey, iv, utf8ToBytes(JSON.stringify(payload)));
  const mac = hmacSha256(macKey, concat(iv, ciphertext));

  return JSON.stringify(
    {
      magic: EXPORT_MAGIC,
      version: EXPORT_VERSION,
      encrypted: true,
      kdf: { name: 'pbkdf2-sha256', iterations, salt: bytesToBase64(salt) },
      cipher: 'aes-256-cbc',
      iv: bytesToBase64(iv),
      mac: bytesToBase64(mac),
      data: bytesToBase64(ciphertext),
      account_count: accounts.length,
      contains_passwords: includePasswords && accounts.some((a) => !!a.password),
    },
    null,
    2
  );
}

export function decryptExport(text, passkey) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (err) {
    throw new MaFileError('That backup file is not valid JSON');
  }
  if (envelope.magic !== EXPORT_MAGIC) throw new MaFileError('That is not a SteamTools backup file');
  if (!envelope.encrypted) {
    return (envelope.accounts || []).map((raw) => normaliseMaFile(raw));
  }
  if (!passkey) throw new MaFileError('This backup is encrypted - enter its password', { code: 'PASSWORD_REQUIRED' });

  const salt = base64ToBytes(envelope.kdf?.salt || '');
  const iterations = Number(envelope.kdf?.iterations) || EXPORT_ITERATIONS;
  const iv = base64ToBytes(envelope.iv || '');
  const ciphertext = base64ToBytes(envelope.data || '');

  const derived = pbkdf2Sha256(passkey, salt, iterations, 64);
  const encryptionKey = derived.slice(0, 32);
  const macKey = derived.slice(32);

  // Verify before decrypting so a wrong password is a clean error.
  const expectedMac = hmacSha256(macKey, concat(iv, ciphertext));
  if (!bytesEqual(expectedMac, base64ToBytes(envelope.mac || ''))) {
    throw new MaFileError('Wrong password, or the backup file has been altered', { code: 'BAD_PASSWORD' });
  }

  const plaintext = bytesToUtf8(aesCbcDecrypt(encryptionKey, iv, ciphertext));
  const payload = parseJsonPreservingSteamIds(plaintext);
  return (payload.accounts || []).map((raw) => normaliseMaFile(raw));
}

/** Peek at a backup without decrypting it, for the import preview. */
export function inspectExport(text) {
  try {
    const envelope = JSON.parse(text);
    if (envelope.magic !== EXPORT_MAGIC) return null;
    return {
      encrypted: !!envelope.encrypted,
      accountCount: Number(envelope.account_count) || 0,
      containsPasswords: !!envelope.contains_passwords,
      exportedAt: Number(envelope.exported_at) || 0,
    };
  } catch (err) {
    return null;
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
