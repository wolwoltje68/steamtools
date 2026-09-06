// Steam's clock is authoritative for Guard codes. A phone that drifts by more
// than ~30s silently produces rejected codes, so we sync an offset once and
// reuse it.
import { API, steamRequest } from './http.js';

let offsetSeconds = 0;
let lastSyncAt = 0;
const RESYNC_AFTER_MS = 60 * 60 * 1000;

export function localUnixTime() {
  return Math.floor(Date.now() / 1000);
}

/** Unix time corrected towards Steam's clock. */
export function steamUnixTime() {
  return localUnixTime() + offsetSeconds;
}

export function getTimeOffset() {
  return offsetSeconds;
}

export async function syncSteamTime({ force = false } = {}) {
  if (!force && lastSyncAt && Date.now() - lastSyncAt < RESYNC_AFTER_MS) return offsetSeconds;
  const { data } = await steamRequest(null, `${API}/ITwoFactorService/QueryTime/v0001/`, {
    method: 'POST',
    form: { steamid: '0' },
  });
  const serverTime = Number(data?.response?.server_time);
  if (!Number.isFinite(serverTime) || serverTime <= 0) {
    throw new Error('Steam did not return a usable server time');
  }
  offsetSeconds = serverTime - localUnixTime();
  lastSyncAt = Date.now();
  return offsetSeconds;
}

/** Test seam. */
export function _setTimeOffset(seconds) {
  offsetSeconds = seconds;
  lastSyncAt = Date.now();
}
