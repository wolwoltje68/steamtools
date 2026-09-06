// Vault settings, encrypted backup/export, and the automation activity log.
import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useApp } from '../state/AppContext.js';
import { encryptExport } from '../steam/maFile.js';
import { CURRENCIES } from '../steam/market.js';
import { KNOWN_APPS } from '../steam/inventory.js';
import { shareText } from '../lib/share.js';
import {
  Banner, Button, Card, Divider, Field, Input, Pill, Screen, SectionHeader, ToggleRow,
} from '../ui/components.js';
import { colors, spacing, typography } from '../ui/theme.js';

const AUTO_LOCK_OPTIONS = [0, 1, 5, 15, 60];

export default function SettingsScreen() {
  const {
    accounts, settings, updateSettings, lock, destroyVault, changeMasterPassword,
    isQuickUnlockEnabled, disableQuickUnlock,
    log, clearLog, automationRunning,
  } = useApp();

  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [quickUnlock, setQuickUnlock] = useState(false);

  const [exportPassword, setExportPassword] = useState('');
  const [includePasswords, setIncludePasswords] = useState(true);

  const [currentMaster, setCurrentMaster] = useState('');
  const [newMaster, setNewMaster] = useState('');

  useEffect(() => {
    isQuickUnlockEnabled().then(setQuickUnlock);
  }, [isQuickUnlockEnabled]);

  async function handleExport() {
    if (exportPassword.length < 6) {
      setError('Choose an export password of at least 6 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bundle = encryptExport(accounts, exportPassword, { includePasswords });
      const filename = `steamtools-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const shared = await shareText(filename, bundle);
      if (!shared) {
        await Clipboard.setStringAsync(bundle);
        setNotice('Sharing is unavailable, so the encrypted backup was copied to the clipboard.');
      } else {
        setNotice(`Exported ${accounts.length} account(s), encrypted.`);
      }
      setExportPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleChangeMaster() {
    setBusy(true);
    setError(null);
    try {
      await changeMasterPassword(currentMaster, newMaster);
      setCurrentMaster('');
      setNewMaster('');
      setNotice('Master password changed and the vault re-encrypted.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleQuickUnlock(value) {
    if (value) {
      setError('Re-enable this from the unlock screen, by ticking "Remember on this device".');
      return;
    }
    await disableQuickUnlock();
    setQuickUnlock(false);
    setNotice('The stored master password was removed from this device.');
  }

  function confirmDestroy() {
    Alert.alert(
      'Erase everything?',
      `This permanently deletes all ${accounts.length} account(s) and their secrets from this device. Export a backup first if you need one.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Erase', style: 'destructive', onPress: destroyVault },
      ]
    );
  }

  return (
    <Screen scroll>
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="success" message={notice} onDismiss={() => setNotice(null)} />

      <SectionHeader title="Automation" />
      <Card>
        <View style={styles.statusRow}>
          <Text style={typography.body}>Engine</Text>
          <Pill
            label={automationRunning ? 'Running' : 'Stopped'}
            tone={automationRunning ? 'success' : 'neutral'}
          />
        </View>
        <Text style={styles.help}>
          Automation runs while the app is open. Enable it per account under Accounts → Settings.
        </Text>
        <ToggleRow
          label="Notifications"
          description="Local notification when automation accepts or confirms something."
          value={settings.notificationsEnabled}
          onValueChange={(value) => updateSettings({ notificationsEnabled: value })}
        />
      </Card>

      <SectionHeader title={`Activity log (${log.length})`} action={log.length ? 'Clear' : undefined} onAction={clearLog} />
      <Card>
        {log.length === 0 ? (
          <Text style={styles.help}>Nothing yet.</Text>
        ) : (
          log.slice(0, 30).map((entry) => (
            <View key={entry.id} style={styles.logRow}>
              <Text style={[styles.logKind, kindStyle(entry.kind)]}>{entry.kind}</Text>
              <View style={styles.logText}>
                <Text style={typography.caption}>
                  {entry.accountName ? `${entry.accountName} · ` : ''}
                  {new Date(entry.at).toLocaleTimeString()}
                </Text>
                <Text style={typography.body}>{entry.message}</Text>
              </View>
            </View>
          ))
        )}
      </Card>

      <SectionHeader title="Backup" />
      <Card>
        <Text style={styles.help}>
          Exports every account as one encrypted file: shared_secret, identity_secret and, if you
          choose, the stored Steam passwords. It can be imported back here or kept as a backup.
        </Text>
        <Field label="Export password" hint="Needed again to import. It is not your master password.">
          <Input
            value={exportPassword}
            onChangeText={setExportPassword}
            secureTextEntry
            placeholder="At least 6 characters"
          />
        </Field>
        <ToggleRow
          label="Include Steam passwords"
          description="Include the stored account passwords in the backup."
          value={includePasswords}
          onValueChange={setIncludePasswords}
        />
        <Button
          title={`Export ${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
          onPress={handleExport}
          loading={busy}
          disabled={accounts.length === 0}
          icon="⬆"
        />
      </Card>

      <SectionHeader title="Defaults" />
      <Card>
        <Text style={typography.label}>CURRENCY</Text>
        <View style={styles.chips}>
          {CURRENCIES.map((entry) => (
            <Button
              key={entry.id}
              title={entry.code}
              variant={settings.currency === entry.id ? 'primary' : 'ghost'}
              onPress={() => updateSettings({ currency: entry.id })}
              style={styles.chip}
            />
          ))}
        </View>

        <Text style={[typography.label, styles.spacedLabel]}>DEFAULT INVENTORY</Text>
        <View style={styles.chips}>
          {KNOWN_APPS.map((entry) => (
            <Button
              key={entry.appid}
              title={entry.name}
              variant={settings.defaultAppId === entry.appid ? 'primary' : 'ghost'}
              onPress={() => updateSettings({ defaultAppId: entry.appid })}
              style={styles.chip}
            />
          ))}
        </View>
      </Card>

      <SectionHeader title="Security" />
      <Card>
        <Text style={typography.label}>AUTO-LOCK AFTER</Text>
        <View style={styles.chips}>
          {AUTO_LOCK_OPTIONS.map((minutes) => (
            <Button
              key={minutes}
              title={minutes === 0 ? 'Never' : minutes < 60 ? `${minutes}m` : '1h'}
              variant={settings.autoLockMinutes === minutes ? 'primary' : 'ghost'}
              onPress={() => updateSettings({ autoLockMinutes: minutes })}
              style={styles.chip}
            />
          ))}
        </View>

        <Divider />

        <ToggleRow
          label="Master password stored on device"
          description="When on, the vault opens without asking. Turn off to require it every time."
          value={quickUnlock}
          onValueChange={toggleQuickUnlock}
        />

        <Divider />

        <Field label="Current master password">
          <Input value={currentMaster} onChangeText={setCurrentMaster} secureTextEntry />
        </Field>
        <Field label="New master password">
          <Input value={newMaster} onChangeText={setNewMaster} secureTextEntry />
        </Field>
        <Button
          title="Change master password"
          variant="secondary"
          onPress={handleChangeMaster}
          loading={busy}
          disabled={!currentMaster || newMaster.length < 6}
        />

        <Button title="Lock now" variant="ghost" onPress={lock} style={styles.spaced} />
        <Button title="Erase everything" variant="danger" onPress={confirmDestroy} style={styles.spaced} />
      </Card>

      <Text style={styles.footnote}>
        SteamTools talks only to steamcommunity.com and api.steampowered.com. Secrets stay on this
        device, encrypted under your master password.
      </Text>
    </Screen>
  );
}

function kindStyle(kind) {
  if (kind === 'error') return { color: '#f0a49c' };
  if (kind === 'accepted' || kind === 'confirmed') return { color: '#b7e08c' };
  return { color: colors.textMuted };
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  help: { ...typography.caption, lineHeight: 18, marginVertical: spacing.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  chip: { flexGrow: 0, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, minHeight: 36 },
  spacedLabel: { marginTop: spacing.lg },
  spaced: { marginTop: spacing.sm },
  logRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.sm },
  logKind: { fontSize: 11, fontWeight: '700', width: 68, textTransform: 'uppercase' },
  logText: { flex: 1, gap: 2 },
  footnote: { ...typography.caption, textAlign: 'center', marginTop: spacing.lg, lineHeight: 17 },
});
