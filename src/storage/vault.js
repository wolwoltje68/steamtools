// Encrypted local vault.
//
// Everything sensitive (shared_secret, identity_secret, Steam passwords,
// refresh tokens) lives inside a single AES-256-CBC blob in AsyncStorage,
// keyed by a master password the user chooses. The derived key never leaves
// memory; only ciphertext is persisted.
//
// The optional "quick unlock" stores the master password in the platform
// keystore (Keychain / Android Keystore) via expo-secure-store, so it is
// protected by the device lock rather than sitting in plain AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { aesCbcDecrypt, aesCbcEncrypt, hmacSha256, pbkdf2Sha256Async } from '../lib/crypto.js';
import { base64ToBytes, bytesToBase64, bytesToUtf8, bytesEqual, concatBytes, utf8ToBytes } from '../lib/bytes.js';
import { randomBytes } from '../lib/random.js';
import { normaliseAutomation } from '../steam/maFile.js';

const VAULT_KEY = 'steamtools.vault.v1';
const QUICK_UNLOCK_KEY = 'steamtools_quick_unlock';
const VAULT_MAGIC = 'steamtools-vault-store';

/**
 * Tuned so unlocking stays under a couple of seconds on a mid-range phone while
 * still being expensive to brute-force. Stored in the blob, so it can be raised
 * later without invalidating existing vaults.
 */
export const VAULT_ITERATIONS = 100000;

export const DEFAULT_SETTINGS = {
  currency: 3, // EUR
  defaultAppId: 730,
  autoLockMinutes: 15,
  confirmBeforeSending: true,
  notificationsEnabled: true,
};

export class VaultError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

// Kept only in memory for the lifetime of the unlocked session.
let encryptionKey = null;
let macKey = null;
let kdfSalt = null;
let kdfIterations = VAULT_ITERATIONS;

export function isUnlocked() {
  return encryptionKey !== null;
}

export function lock() {
  encryptionKey = null;
  macKey = null;
  kdfSalt = null;
}

export async function vaultExists() {
  return (await AsyncStorage.getItem(VAULT_KEY)) !== null;
}

async function deriveKeys(masterPassword, salt, iterations, onProgress) {
  const derived = await pbkdf2Sha256Async(masterPassword, salt, iterations, 64, onProgress);
  return { encryptionKey: derived.slice(0, 32), macKey: derived.slice(32) };
}

function emptyState() {
  return { accounts: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Create a brand new vault and leave it unlocked. */
export async function createVault(masterPassword, onProgress) {
  if (!masterPassword || masterPassword.length < 6) {
    throw new VaultError('Choose a master password of at least 6 characters', { code: 'WEAK_PASSWORD' });
  }
  kdfSalt = randomBytes(16);
  kdfIterations = VAULT_ITERATIONS;
  const keys = await deriveKeys(masterPassword, kdfSalt, kdfIterations, onProgress);
  encryptionKey = keys.encryptionKey;
  macKey = keys.macKey;

  const state = emptyState();
  await save(state);
  return state;
}

/** Unlock an existing vault. Throws VaultError('BAD_PASSWORD') on a wrong one. */
export async function unlockVault(masterPassword, onProgress) {
  const stored = await AsyncStorage.getItem(VAULT_KEY);
  if (!stored) throw new VaultError('There is no vault on this device yet', { code: 'NO_VAULT' });

  let envelope;
  try {
    envelope = JSON.parse(stored);
  } catch (err) {
    throw new VaultError('The stored vault is corrupt', { code: 'CORRUPT' });
  }
  if (envelope.magic !== VAULT_MAGIC) throw new VaultError('The stored vault is corrupt', { code: 'CORRUPT' });

  const salt = base64ToBytes(envelope.salt);
  const iterations = Number(envelope.iterations) || VAULT_ITERATIONS;
  const keys = await deriveKeys(masterPassword, salt, iterations, onProgress);

  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.data);
  const expectedMac = hmacSha256(keys.macKey, concatBytes(iv, ciphertext));
  if (!bytesEqual(expectedMac, base64ToBytes(envelope.mac || ''))) {
    throw new VaultError('Wrong master password', { code: 'BAD_PASSWORD' });
  }

  let state;
  try {
    state = JSON.parse(bytesToUtf8(aesCbcDecrypt(keys.encryptionKey, iv, ciphertext)));
  } catch (err) {
    throw new VaultError('The stored vault could not be decrypted', { code: 'CORRUPT' });
  }

  encryptionKey = keys.encryptionKey;
  macKey = keys.macKey;
  kdfSalt = salt;
  kdfIterations = iterations;

  return hydrate(state);
}

function hydrate(state) {
  return {
    accounts: (state.accounts || []).map((account) => ({
      ...account,
      automation: normaliseAutomation(account.automation),
    })),
    settings: { ...DEFAULT_SETTINGS, ...(state.settings || {}) },
  };
}

/** Persist the whole state. Requires an unlocked vault. */
export async function save(state) {
  if (!encryptionKey || !macKey || !kdfSalt) {
    throw new VaultError('The vault is locked', { code: 'LOCKED' });
  }
  const iv = randomBytes(16);
  const plaintext = utf8ToBytes(JSON.stringify({ accounts: state.accounts, settings: state.settings }));
  const ciphertext = aesCbcEncrypt(encryptionKey, iv, plaintext);
  const mac = hmacSha256(macKey, concatBytes(iv, ciphertext));

  await AsyncStorage.setItem(
    VAULT_KEY,
    JSON.stringify({
      magic: VAULT_MAGIC,
      version: 1,
      salt: bytesToBase64(kdfSalt),
      iterations: kdfIterations,
      iv: bytesToBase64(iv),
      mac: bytesToBase64(mac),
      data: bytesToBase64(ciphertext),
    })
  );
}

/** Re-encrypt everything under a new master password. */
export async function changeMasterPassword(currentPassword, newPassword, onProgress) {
  const state = await unlockVault(currentPassword, onProgress);
  if (!newPassword || newPassword.length < 6) {
    throw new VaultError('Choose a master password of at least 6 characters', { code: 'WEAK_PASSWORD' });
  }
  kdfSalt = randomBytes(16);
  kdfIterations = VAULT_ITERATIONS;
  const keys = await deriveKeys(newPassword, kdfSalt, kdfIterations, onProgress);
  encryptionKey = keys.encryptionKey;
  macKey = keys.macKey;
  await save(state);

  if (await isQuickUnlockEnabled()) await enableQuickUnlock(newPassword);
  return state;
}

/** Wipe the vault and any stored quick-unlock secret. */
export async function destroyVault() {
  lock();
  await AsyncStorage.removeItem(VAULT_KEY);
  await disableQuickUnlock();
}

// --- Quick unlock (device keystore) ---------------------------------------

export async function isQuickUnlockEnabled() {
  try {
    return (await SecureStore.getItemAsync(QUICK_UNLOCK_KEY)) !== null;
  } catch (err) {
    return false;
  }
}

export async function enableQuickUnlock(masterPassword) {
  try {
    await SecureStore.setItemAsync(QUICK_UNLOCK_KEY, masterPassword, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return true;
  } catch (err) {
    return false;
  }
}

export async function disableQuickUnlock() {
  try {
    await SecureStore.deleteItemAsync(QUICK_UNLOCK_KEY);
  } catch (err) {
    // Nothing stored; nothing to do.
  }
}

export async function getQuickUnlockPassword() {
  try {
    return await SecureStore.getItemAsync(QUICK_UNLOCK_KEY);
  } catch (err) {
    return null;
  }
}
