// Per-account settings: stored password, export, and the automation rules.
import React, { useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useApp } from '../state/AppContext.js';
import { accountToMaFile, serialiseMaFile } from '../steam/maFile.js';
import { isValidSteamId64 } from '../steam/steamid.js';
import { shareText } from '../lib/share.js';
import {
  Banner, Button, Card, Divider, Field, Input, Pill, Screen, SectionHeader, ToggleRow,
} from '../ui/components.js';
import { spacing, typography } from '../ui/theme.js';

const INTERVALS = [30, 60, 120, 300, 600];

export default function AccountDetailScreen({ route }) {
  const { accounts, updateAccount, setAutomationRules, signOutAccount, runAutomationNow } = useApp();
  const accountId = route.params?.accountId;
  const account = accounts.find((candidate) => candidate.id === accountId);

  const [password, setPassword] = useState(account?.password || '');
  const [trustedInput, setTrustedInput] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const rules = account?.automation;
  const trusted = useMemo(() => rules?.trustedSteamIds || [], [rules]);

  if (!account) {
    return (
      <Screen>
        <Banner kind="error" message="That account is no longer in the vault." />
      </Screen>
    );
  }

  async function savePassword() {
    await updateAccount(account.id, { password: password || null });
    setNotice(password ? 'Password saved to the vault.' : 'Password removed.');
  }

  async function exportSingle() {
    const text = serialiseMaFile(accountToMaFile(account));
    const ok = await shareText(`${account.accountName}.maFile`, text);
    if (!ok) {
      await Clipboard.setStringAsync(text);
      setNotice('Sharing is unavailable, so the maFile was copied to the clipboard instead.');
    }
  }

  function addTrusted() {
    const value = trustedInput.trim();
    if (!isValidSteamId64(value)) {
      setError('Enter a valid 17-digit SteamID64.');
      return;
    }
    if (trusted.includes(value)) {
      setError('That SteamID is already trusted.');
      return;
    }
    setError(null);
    setTrustedInput('');
    setAutomationRules(account.id, { trustedSteamIds: [...trusted, value] });
  }

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      await runAutomationNow(account.id);
      setNotice('Automation pass finished. See the log under Settings.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const canConfirm = !!account.identitySecret;

  return (
    <Screen scroll>
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="success" message={notice} onDismiss={() => setNotice(null)} />

      <Card>
        <Text style={typography.title}>{account.accountName}</Text>
        <Text style={typography.caption}>{account.steamId || 'No SteamID stored'}</Text>
        <View style={styles.badges}>
          <Pill label={account.accessToken ? 'Session active' : 'Signed out'} tone={account.accessToken ? 'success' : 'neutral'} />
          {account.revocationCode ? <Pill label={`Revocation ${account.revocationCode}`} /> : null}
        </View>
      </Card>

      <SectionHeader title="Stored password" />
      <Card>
        <Field
          label="Steam password"
          hint="Optional. With it stored the app can sign back in on its own when the session expires, and automation keeps working unattended."
        >
          <Input value={password} onChangeText={setPassword} secureTextEntry placeholder="Not stored" />
        </Field>
        <Button title="Save password" onPress={savePassword} variant="secondary" />
        <Button
          title="Sign out (keep account)"
          onPress={() => signOutAccount(account.id)}
          variant="ghost"
          style={styles.spaced}
        />
      </Card>

      <SectionHeader title="Automation" />
      <Card>
        <ToggleRow
          label="Enable automation"
          description="Polls Steam on a timer while the app is open."
          value={rules.enabled}
          onValueChange={(value) => setAutomationRules(account.id, { enabled: value })}
        />
        <Divider />

        <ToggleRow
          label="Confirm trades"
          description={canConfirm ? 'Automatically approve pending trade confirmations.' : 'Needs an identity_secret.'}
          value={rules.confirmTrades}
          disabled={!canConfirm}
          onValueChange={(value) => setAutomationRules(account.id, { confirmTrades: value })}
        />
        <ToggleRow
          label="Confirm market listings"
          description={canConfirm ? 'Automatically approve market sell confirmations.' : 'Needs an identity_secret.'}
          value={rules.confirmMarket}
          disabled={!canConfirm}
          onValueChange={(value) => setAutomationRules(account.id, { confirmMarket: value })}
        />

        <Divider />

        <ToggleRow
          label="Accept gift offers"
          description="Only offers where you give up nothing at all."
          value={rules.acceptGiftOffers}
          onValueChange={(value) => setAutomationRules(account.id, { acceptGiftOffers: value })}
        />
        <ToggleRow
          label="Accept from trusted accounts"
          description="Accepts any offer from the SteamIDs listed below, including ones that take your items."
          value={rules.acceptFromTrusted}
          onValueChange={(value) => setAutomationRules(account.id, { acceptFromTrusted: value })}
        />
        <ToggleRow
          label="Decline everything else"
          description="Declines every other incoming offer. Leave off unless you are sure."
          value={rules.declineOthers}
          onValueChange={(value) => setAutomationRules(account.id, { declineOthers: value })}
        />
        <ToggleRow
          label="Notify me"
          description="Send a local notification when automation acts."
          value={rules.notify}
          onValueChange={(value) => setAutomationRules(account.id, { notify: value })}
        />

        <Divider />

        <Text style={typography.label}>CHECK EVERY</Text>
        <View style={styles.intervals}>
          {INTERVALS.map((seconds) => (
            <Button
              key={seconds}
              title={seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
              variant={rules.intervalSeconds === seconds ? 'primary' : 'ghost'}
              onPress={() => setAutomationRules(account.id, { intervalSeconds: seconds })}
              style={styles.interval}
            />
          ))}
        </View>

        <Button title="Run one pass now" onPress={runNow} loading={busy} variant="secondary" style={styles.spaced} />
      </Card>

      <SectionHeader title="Trusted accounts" />
      <Card>
        <Field label="Add SteamID64">
          <Input
            value={trustedInput}
            onChangeText={setTrustedInput}
            placeholder="7656119..."
            keyboardType="number-pad"
            onSubmitEditing={addTrusted}
          />
        </Field>
        <Button title="Add to trusted" onPress={addTrusted} variant="secondary" />

        {trusted.length === 0 ? (
          <Text style={styles.help}>No trusted accounts yet.</Text>
        ) : (
          trusted.map((steamId) => (
            <View key={steamId} style={styles.trustedRow}>
              <Text style={typography.body}>{steamId}</Text>
              <Button
                title="Remove"
                variant="ghost"
                onPress={() =>
                  setAutomationRules(account.id, {
                    trustedSteamIds: trusted.filter((candidate) => candidate !== steamId),
                  })
                }
              />
            </View>
          ))
        )}
      </Card>

      <SectionHeader title="Export" />
      <Card>
        <Text style={styles.help}>
          Exports a single .maFile compatible with SteamDesktopAuthenticator, including the stored
          password when there is one. It is not encrypted, so share it carefully.
        </Text>
        <Button
          title="Export this maFile"
          variant="secondary"
          icon="⬆"
          onPress={() =>
            Alert.alert(
              'Export unencrypted?',
              'This file contains the shared_secret, identity_secret and the stored password in plain text.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Export', style: 'destructive', onPress: exportSingle },
              ]
            )
          }
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  spaced: { marginTop: spacing.sm },
  help: { ...typography.caption, lineHeight: 18, marginBottom: spacing.md },
  intervals: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  interval: { flexGrow: 1, minWidth: 56, paddingHorizontal: spacing.sm, paddingVertical: spacing.sm, minHeight: 38 },
  trustedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
});
