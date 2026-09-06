// Application state: vault lifecycle, accounts, sessions and automation.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import * as vault from '../storage/vault.js';
import { AutomationEngine } from './automation.js';
import { login, needsRenewal, renewAccessToken, SteamLoginError } from '../steam/session.js';
import { newSessionId } from '../steam/http.js';
import { getDeviceId } from '../steam/guard.js';
import { syncSteamTime } from '../steam/time.js';
import { normaliseAutomation } from '../steam/maFile.js';
import { notify, setupNotifications } from '../lib/notify.js';
import { randomUuid } from '../lib/random.js';

const AppContext = createContext(null);
const MAX_LOG_ENTRIES = 200;

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside <AppProvider>');
  return context;
}

export function AppProvider({ children }) {
  const [status, setStatus] = useState('loading'); // loading | setup | locked | unlocked
  const [accounts, setAccounts] = useState([]);
  const [settings, setSettings] = useState(vault.DEFAULT_SETTINGS);
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [log, setLog] = useState([]);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [unlockProgress, setUnlockProgress] = useState(0);

  // The engine reads accounts through a ref so it always sees current data
  // without being torn down and rebuilt on every state change.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  // Settings go through a ref too. If `persist` closed over `settings`, every
  // settings change would produce a new persist -> updateAccounts ->
  // ensureSession identity, tearing down and rebuilding the automation engine
  // without the start effect below ever re-running, which stops automation
  // silently.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const engineRef = useRef(null);
  const backgroundedAt = useRef(null);

  const appendLog = useCallback((entry) => {
    setLog((previous) => [entry, ...previous].slice(0, MAX_LOG_ENTRIES));
  }, []);

  // --- persistence -------------------------------------------------------

  const persist = useCallback(async (nextAccounts, nextSettings) => {
    await vault.save({
      accounts: nextAccounts ?? accountsRef.current,
      settings: nextSettings ?? settingsRef.current,
    });
  }, []);

  const updateAccounts = useCallback(
    async (updater) => {
      const next = typeof updater === 'function' ? updater(accountsRef.current) : updater;
      accountsRef.current = next;
      setAccounts(next);
      await persist(next);
      return next;
    },
    [persist]
  );

  const updateAccount = useCallback(
    (accountId, patch) =>
      updateAccounts((current) =>
        current.map((account) => (account.id === accountId ? { ...account, ...patch } : account))
      ),
    [updateAccounts]
  );

  // --- vault lifecycle ---------------------------------------------------

  useEffect(() => {
    (async () => {
      const exists = await vault.vaultExists();
      if (!exists) {
        setStatus('setup');
        return;
      }
      const quickPassword = await vault.getQuickUnlockPassword();
      if (quickPassword) {
        try {
          const state = await vault.unlockVault(quickPassword, setUnlockProgress);
          applyState(state);
          return;
        } catch (err) {
          await vault.disableQuickUnlock();
        }
      }
      setStatus('locked');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyState(state) {
    accountsRef.current = state.accounts;
    setAccounts(state.accounts);
    setSettings(state.settings);
    setActiveAccountId((current) => current || state.accounts[0]?.id || null);
    setStatus('unlocked');
    setUnlockProgress(0);
    syncSteamTime().catch(() => {});
    setupNotifications().catch(() => {});
  }

  const createVault = useCallback(async (masterPassword, rememberOnDevice) => {
    const state = await vault.createVault(masterPassword, setUnlockProgress);
    if (rememberOnDevice) await vault.enableQuickUnlock(masterPassword);
    applyState(state);
  }, []);

  const unlock = useCallback(async (masterPassword, rememberOnDevice) => {
    const state = await vault.unlockVault(masterPassword, setUnlockProgress);
    if (rememberOnDevice) await vault.enableQuickUnlock(masterPassword);
    applyState(state);
  }, []);

  const lock = useCallback(() => {
    engineRef.current?.stop();
    setAutomationRunning(false);
    vault.lock();
    setAccounts([]);
    accountsRef.current = [];
    setStatus('locked');
  }, []);

  // --- sessions ----------------------------------------------------------

  /**
   * Return a copy of the account that has a usable web session, renewing or
   * re-logging in as needed. Throws if neither is possible.
   */
  const ensureSession = useCallback(
    async (accountOrId) => {
      const id = typeof accountOrId === 'string' ? accountOrId : accountOrId.id;
      let account = accountsRef.current.find((candidate) => candidate.id === id);
      if (!account) throw new Error('That account is no longer in the vault');

      if (!account.sessionId) {
        account = { ...account, sessionId: newSessionId() };
        await updateAccount(id, { sessionId: account.sessionId });
      }
      if (!needsRenewal(account)) return account;

      if (account.refreshToken) {
        try {
          const renewed = await renewAccessToken(account);
          await updateAccount(id, renewed);
          return { ...account, ...renewed };
        } catch (err) {
          // Refresh token expired or revoked; fall through to a full sign-in.
        }
      }

      if (!account.password) {
        throw new SteamLoginError(
          `${account.accountName} needs to sign in again. Add its password, or sign in manually.`,
          { code: 'SIGN_IN_REQUIRED' }
        );
      }

      const result = await login({
        accountName: account.accountName,
        password: account.password,
        sharedSecret: account.sharedSecret,
      });
      const patch = {
        steamId: account.steamId || result.steamId,
        refreshToken: result.refreshToken,
        accessToken: result.accessToken,
        accessTokenExpires: result.accessTokenExpires,
        sessionId: result.sessionId,
        deviceId: account.deviceId || getDeviceId(account.steamId || result.steamId),
      };
      await updateAccount(id, patch);
      return { ...account, ...patch };
    },
    [updateAccount]
  );

  const signOutAccount = useCallback(
    (accountId) =>
      updateAccount(accountId, { accessToken: null, refreshToken: null, accessTokenExpires: 0 }),
    [updateAccount]
  );

  // --- account CRUD ------------------------------------------------------

  const addAccounts = useCallback(
    async (incoming, { replaceExisting = true } = {}) => {
      let added = 0;
      let replaced = 0;
      await updateAccounts((current) => {
        const next = [...current];
        for (const account of incoming) {
          const prepared = {
            ...account,
            id: account.id || randomUuid(),
            automation: normaliseAutomation(account.automation),
          };
          // Match on steamId when present, otherwise on the account name.
          const index = next.findIndex((existing) =>
            prepared.steamId
              ? existing.steamId === prepared.steamId
              : existing.accountName.toLowerCase() === prepared.accountName.toLowerCase()
          );
          if (index >= 0) {
            if (!replaceExisting) continue;
            // Keep the live session and any password we already had.
            next[index] = {
              ...next[index],
              ...prepared,
              id: next[index].id,
              password: prepared.password || next[index].password,
              refreshToken: prepared.refreshToken || next[index].refreshToken,
              accessToken: prepared.accessToken || next[index].accessToken,
              accessTokenExpires: prepared.accessTokenExpires || next[index].accessTokenExpires,
            };
            replaced += 1;
          } else {
            next.push(prepared);
            added += 1;
          }
        }
        return next;
      });
      setActiveAccountId((current) => current || accountsRef.current[0]?.id || null);
      return { added, replaced };
    },
    [updateAccounts]
  );

  const removeAccount = useCallback(
    async (accountId) => {
      await updateAccounts((current) => current.filter((account) => account.id !== accountId));
      setActiveAccountId((current) => (current === accountId ? accountsRef.current[0]?.id || null : current));
    },
    [updateAccounts]
  );

  const setAutomationRules = useCallback(
    (accountId, patch) =>
      updateAccounts((current) =>
        current.map((account) =>
          account.id === accountId
            ? { ...account, automation: normaliseAutomation({ ...account.automation, ...patch }) }
            : account
        )
      ),
    [updateAccounts]
  );

  const updateSettings = useCallback(
    async (patch) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      await persist(undefined, next);
      return next;
    },
    [persist]
  );

  // --- automation --------------------------------------------------------

  // The engine reaches the current callbacks through a ref so it is constructed
  // once and never torn down mid-run by an unrelated re-render.
  const engineHooks = useRef(null);
  engineHooks.current = { ensureSession, appendLog, notificationsEnabled: settings.notificationsEnabled };

  useEffect(() => {
    engineRef.current = new AutomationEngine({
      getAccounts: () => accountsRef.current,
      ensureSession: (account) => engineHooks.current.ensureSession(account),
      onLog: (entry) => engineHooks.current.appendLog(entry),
      onNotify: (title, body) => {
        if (engineHooks.current.notificationsEnabled) notify(title, body);
      },
    });
    return () => engineRef.current?.stop();
  }, []);

  const anyAutomationEnabled = useMemo(
    () => accounts.some((account) => account.automation?.enabled),
    [accounts]
  );

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (status === 'unlocked' && anyAutomationEnabled) {
      engine.start();
      setAutomationRunning(true);
    } else {
      engine.stop();
      setAutomationRunning(false);
    }
  }, [status, anyAutomationEnabled]);

  const runAutomationNow = useCallback(
    async (accountId) => {
      const account = accountsRef.current.find((candidate) => candidate.id === accountId);
      if (!account) return;
      engineRef.current?.scheduleNow(accountId);
      await engineRef.current?.runOnce(account);
    },
    []
  );

  // --- auto-lock ---------------------------------------------------------

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current = Date.now();
        return;
      }
      if (next !== 'active' || backgroundedAt.current === null) return;

      const awayMinutes = (Date.now() - backgroundedAt.current) / 60000;
      backgroundedAt.current = null;
      const limit = Number(settings.autoLockMinutes);
      if (limit > 0 && awayMinutes >= limit && vault.isUnlocked()) lock();
    });
    return () => subscription.remove();
  }, [settings.autoLockMinutes, lock]);

  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === activeAccountId) || accounts[0] || null,
    [accounts, activeAccountId]
  );

  const value = useMemo(
    () => ({
      status,
      accounts,
      settings,
      activeAccount,
      activeAccountId: activeAccount?.id || null,
      setActiveAccountId,
      log,
      clearLog: () => setLog([]),
      unlockProgress,
      automationRunning,
      createVault,
      unlock,
      lock,
      destroyVault: async () => {
        await vault.destroyVault();
        setAccounts([]);
        accountsRef.current = [];
        setStatus('setup');
      },
      changeMasterPassword: vault.changeMasterPassword,
      isQuickUnlockEnabled: vault.isQuickUnlockEnabled,
      enableQuickUnlock: vault.enableQuickUnlock,
      disableQuickUnlock: vault.disableQuickUnlock,
      addAccounts,
      removeAccount,
      updateAccount,
      setAutomationRules,
      updateSettings,
      ensureSession,
      signOutAccount,
      runAutomationNow,
    }),
    [
      status, accounts, settings, activeAccount, log, unlockProgress, automationRunning,
      createVault, unlock, lock, addAccounts, removeAccount, updateAccount,
      setAutomationRules, updateSettings, ensureSession, signOutAccount, runAutomationNow,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
