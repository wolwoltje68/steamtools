// SteamID conversions. Trade URLs carry the 32-bit account id, everything else
// uses the 64-bit form, so both directions are needed.
const BASE = 76561197960265728n;

export function accountIdToSteamId64(accountId) {
  return (BigInt(accountId) + BASE).toString();
}

export function steamId64ToAccountId(steamId64) {
  return (BigInt(steamId64) - BASE).toString();
}

export function isValidSteamId64(value) {
  if (!/^\d{17}$/.test(String(value || ''))) return false;
  try {
    return BigInt(value) > BASE;
  } catch (err) {
    return false;
  }
}
