// Account list: session state, quick sign-in and navigation to per-account settings.
import React, { useCallback, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import { needsRenewal } from '../steam/session.js';
import { Banner, Button, Card, EmptyState, Pill, Screen, SectionHeader } from '../ui/components.js';
import { colors, spacing, typography } from '../ui/theme.js';

export default function AccountsScreen({ navigation }) {
  const { accounts, ensureSession, removeAccount, setActiveAccountId, automationRunning } = useApp();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const signIn = useCallback(
    async (account) => {
      setBusyId(account.id);
      setError(null);
      try {
        await ensureSession(account.id);
        setNotice(`${account.accountName} is signed in.`);
      } catch (err) {
        setError(`${account.accountName}: ${err.message}`);
      } finally {
        setBusyId(null);
      }
    },
    [ensureSession]
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
              {account.identitySecret ? null : <Pill label="No identity_secret" tone="warning" />}
              {account.automation?.enabled ? (
                <Pill label={automationRunning ? 'Automation on' : 'Automation idle'} tone="success" />
              ) : null}
            </View>

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
});
