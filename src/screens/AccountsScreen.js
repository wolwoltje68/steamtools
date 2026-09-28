// Account list: session state, quick sign-in and navigation to per-account settings.
import React, { useCallback, useRef, useState } from 'react';
import { Alert, Modal, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import { needsRenewal } from '../steam/session.js';
import { accountCapabilities, describeGuardKind, GuardKind } from '../steam/maFile.js';
import { Banner, Button, Card, EmptyState, Field, Input, Pill, Screen, SectionHeader } from '../ui/components.js';
import { colors, spacing, typography } from '../ui/theme.js';

export default function AccountsScreen({ navigation }) {
  const { accounts, ensureSession, removeAccount, setActiveAccountId, automationRunning } = useApp();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Steam emails a code to accounts with no mobile authenticator. Only a person
  // can read it, so sign-in pauses here until they type it in.
  const [guardPrompt, setGuardPrompt] = useState(null);
  const [guardCode, setGuardCode] = useState('');
  const guardResolver = useRef(null);

  const askForGuardCode = useCallback(
    (request) =>
      new Promise((resolve) => {
        guardResolver.current = resolve;
        setGuardCode('');
        setGuardPrompt(request);
      }),
    []
  );

  const submitGuardCode = useCallback(() => {
    const resolve = guardResolver.current;
    guardResolver.current = null;
    setGuardPrompt(null);
    if (resolve) resolve(guardCode.trim().toUpperCase());
  }, [guardCode]);

  const cancelGuardCode = useCallback(() => {
    const resolve = guardResolver.current;
    guardResolver.current = null;
    setGuardPrompt(null);
    if (resolve) resolve(null); // login turns this into a readable error
  }, []);

  const signIn = useCallback(
    async (account) => {
      setBusyId(account.id);
      setError(null);
      try {
        await ensureSession(account.id, { onGuardRequired: askForGuardCode });
        setNotice(`${account.accountName} is signed in.`);
      } catch (err) {
        setError(`${account.accountName}: ${err.message}`);
      } finally {
        setBusyId(null);
      }
    },
    [ensureSession, askForGuardCode]
  );

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const failures = [];
    for (const account of accounts) {
      try {
        await ensureSession(account.id);
      } catch (err) {
        failures.push(`${account.accountName}: ${err.message}`);
      }
    }
    if (failures.length) setError(failures.join('\n'));
    setRefreshing(false);
  }, [accounts, ensureSession]);

  function confirmRemove(account) {
    Alert.alert(
      `Remove ${account.accountName}?`,
      'This deletes the account from this device only. Export a backup first if you have no other copy of its maFile.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => removeAccount(account.id) },
      ]
    );
  }

  if (accounts.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="👤"
          title="No accounts yet"
          description="Import maFiles from SteamDesktopAuthenticator or a SteamTools backup, or add an account by hand."
          action="Add an account"
          onAction={() => navigation.navigate('AddAccount')}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={colors.accent} />}>
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="success" message={notice} onDismiss={() => setNotice(null)} />

      <SectionHeader
        title={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
        action="Add"
        onAction={() => navigation.navigate('AddAccount')}
      />

      {accounts.map((account) => {
        const signedIn = !!account.accessToken && !needsRenewal(account);
        const capabilities = accountCapabilities(account);
        return (
          <Card key={account.id}>
            <View style={styles.row}>
              <View style={styles.identity}>
                <Text style={typography.heading} numberOfLines={1}>
                  {account.accountName}
                </Text>
                <Text style={typography.caption} numberOfLines={1}>
                  {account.steamId || 'No SteamID stored'}
                </Text>
              </View>
              <Pill
                label={signedIn ? 'Signed in' : 'Signed out'}
                tone={signedIn ? 'success' : 'neutral'}
              />
            </View>

            <View style={styles.badges}>
              {account.password ? <Pill label="Password saved" tone="accent" /> : null}
              <Pill
                label={describeGuardKind(capabilities.guardKind).short}
                tone={
                  capabilities.guardKind === GuardKind.Mobile
                    ? 'success'
                    : capabilities.guardKind === GuardKind.None
                      ? 'danger'
                      : 'warning'
                }
              />
              {capabilities.holdDays ? <Pill label={`${capabilities.holdDays}-day hold`} tone="warning" /> : null}
              {account.sharedSecret && !account.identitySecret ? (
                <Pill label="No identity_secret" tone="warning" />
              ) : null}
              {account.automation?.enabled ? (
                <Pill label={automationRunning ? 'Automation on' : 'Automation idle'} tone="success" />
              ) : null}
            </View>

            {capabilities.canTrade === false || !capabilities.canSendTrades ? (
              <Text style={styles.limitNote}>{capabilities.limitsSummary}</Text>
            ) : null}

            <View style={styles.actions}>
              <Button
                title={signedIn ? 'Refresh session' : 'Sign in'}
                variant={signedIn ? 'ghost' : 'primary'}
                loading={busyId === account.id}
                onPress={() => signIn(account)}
                style={styles.action}
              />
              <Button
                title="Settings"
                variant="secondary"
                onPress={() => {
                  setActiveAccountId(account.id);
                  navigation.navigate('AccountDetail', { accountId: account.id });
                }}
                style={styles.action}
              />
            </View>

            <Button
              title="Remove from this device"
              variant="ghost"
              onPress={() => confirmRemove(account)}
              style={styles.remove}
            />
          </Card>
        );
      })}

      <Modal visible={!!guardPrompt} transparent animationType="fade" onRequestClose={cancelGuardCode}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={typography.heading}>Steam Guard code</Text>
            <Text style={styles.modalHelp}>
              {guardPrompt?.message ||
                'Steam sent a code to the email address on this account. Enter it to finish signing in.'}
            </Text>
            <Field>
              <Input
                value={guardCode}
                onChangeText={setGuardCode}
                placeholder="ABCDE"
                autoCapitalize="characters"
                autoFocus
                maxLength={8}
                onSubmitEditing={submitGuardCode}
                returnKeyType="go"
              />
            </Field>
            <View style={styles.modalActions}>
              <Button title="Cancel" variant="ghost" onPress={cancelGuardCode} style={styles.modalAction} />
              <Button
                title="Sign in"
                onPress={submitGuardCode}
                disabled={guardCode.trim().length < 5}
                style={styles.modalAction}
              />
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  identity: { flex: 1, gap: 2 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  action: { flex: 1 },
  remove: { marginTop: spacing.sm, borderColor: 'transparent' },
  limitNote: { ...typography.caption, color: colors.warning, marginTop: spacing.sm, lineHeight: 17 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  modalHelp: { ...typography.caption, lineHeight: 18, marginBottom: spacing.sm },
  modalActions: { flexDirection: 'row', gap: spacing.sm },
  modalAction: { flex: 1 },
});
