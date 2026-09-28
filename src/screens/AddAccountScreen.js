// Add accounts: import maFiles / backups, or enter secrets by hand.
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

import { useApp } from '../state/AppContext.js';
import {
  decryptExport,
  decryptSdaMaFile,
  inspectExport,
  MaFileError,
  normaliseMaFile,
  parseJsonPreservingSteamIds,
  parseMaFileText,
} from '../steam/maFile.js';
import { Banner, Button, Card, Field, Input, Screen, SectionHeader, ToggleRow } from '../ui/components.js';
import { spacing, typography } from '../ui/theme.js';

export default function AddAccountScreen({ navigation }) {
  const { addAccounts } = useApp();
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [pending, setPending] = useState(null); // files awaiting a passphrase

  const [manual, setManual] = useState({
    accountName: '',
    steamId: '',
    sharedSecret: '',
    identitySecret: '',
    password: '',
  });
  // Accounts without the Steam mobile authenticator are legitimate; they just
  // cannot generate codes or approve confirmations.
  const [noAuthenticator, setNoAuthenticator] = useState(false);

  async function readFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
      type: ['application/json', 'text/plain', '*/*'],
    });
    if (result.canceled) return null;

    const files = [];
    for (const asset of result.assets) {
      const content = await FileSystem.readAsStringAsync(asset.uri);
      files.push({ name: asset.name || 'file', content });
    }
    return files;
  }

  /**
   * Import whatever was picked. Handles three shapes: a SteamTools backup, a
   * plain SDA maFile, and an SDA-encrypted maFile accompanied by the
   * manifest.json that holds its salt and IV.
   */
  async function importFiles(files, secret) {
    const manifest = files.find((file) => /manifest\.json$/i.test(file.name));
    let manifestEntries = [];
    if (manifest) {
      try {
        manifestEntries = parseJsonPreservingSteamIds(manifest.content).entries || [];
      } catch (err) {
        manifestEntries = [];
      }
    }

    const imported = [];
    const problems = [];
    let needsPassphrase = false;

    for (const file of files) {
      if (/manifest\.json$/i.test(file.name)) continue;

      const backupInfo = inspectExport(file.content);
      if (backupInfo) {
        if (backupInfo.encrypted && !secret) {
          needsPassphrase = true;
          continue;
        }
        try {
          imported.push(...decryptExport(file.content, secret));
        } catch (err) {
          problems.push(`${file.name}: ${err.message}`);
        }
        continue;
      }

      try {
        imported.push(parseMaFileText(file.content, { sourceName: file.name.replace(/\.maFile$/i, '') }));
      } catch (err) {
        if (err instanceof MaFileError && err.code === 'SDA_ENCRYPTED') {
          const entry = manifestEntries.find((candidate) => candidate.filename === file.name);
          if (!entry) {
            problems.push(
              `${file.name} is encrypted by SteamDesktopAuthenticator. Pick its manifest.json in the same selection.`
            );
            continue;
          }
          if (!secret) {
            needsPassphrase = true;
            continue;
          }
          try {
            const decrypted = decryptSdaMaFile(
              file.content,
              secret,
              entry.encryption_salt,
              entry.encryption_iv
            );
            imported.push(parseMaFileText(decrypted, { sourceName: file.name }));
          } catch (innerError) {
            problems.push(`${file.name}: ${innerError.message}`);
          }
          continue;
        }
        problems.push(`${file.name}: ${err.message}`);
      }
    }

    if (needsPassphrase && imported.length === 0) {
      setPending(files);
      setError('One or more files are encrypted. Enter their password below and import again.');
      return;
    }

    if (imported.length === 0) {
      setError(problems.join('\n') || 'Nothing importable was found in those files.');
      return;
    }

    const { added, replaced } = await addAccounts(imported);
    setPending(null);
    setPassphrase('');
    setError(problems.length ? problems.join('\n') : null);
    setNotice(
      `Imported ${added} new account${added === 1 ? '' : 's'}` +
        (replaced ? `, updated ${replaced}` : '') +
        '.'
    );
  }

  async function handlePick() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const files = await readFiles();
      if (files) await importFiles(files, passphrase || undefined);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryWithPassphrase() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await importFiles(pending, passphrase);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleManualAdd() {
    setError(null);
    setNotice(null);
    try {
      const account = normaliseMaFile(
        {
          account_name: manual.accountName.trim(),
          steamid: manual.steamId.trim(),
          shared_secret: noAuthenticator ? '' : manual.sharedSecret.trim(),
          identity_secret: noAuthenticator ? '' : manual.identitySecret.trim(),
          password: manual.password || undefined,
        },
        { requireSharedSecret: !noAuthenticator }
      );
      await addAccounts([account]);
      setManual({ accountName: '', steamId: '', sharedSecret: '', identitySecret: '', password: '' });
      setNotice(`Added ${account.accountName}.`);
      navigation.goBack();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Screen scroll>
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="success" message={notice} onDismiss={() => setNotice(null)} />

      <SectionHeader title="Import files" />
      <Card>
        <Text style={typography.body}>Import maFiles or a backup</Text>
        <Text style={styles.help}>
          Select one or more .maFile files, or a SteamTools backup. For files encrypted by
          SteamDesktopAuthenticator, select their manifest.json in the same go so the salt and IV can
          be read.
        </Text>

        <Field label="Password (only for encrypted files)">
          <Input
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            placeholder="Leave empty for plain maFiles"
          />
        </Field>

        <Button title="Choose files" onPress={handlePick} loading={busy} icon="📂" />
        {pending ? (
          <Button
            title="Import again with this password"
            variant="secondary"
            onPress={handleRetryWithPassphrase}
            loading={busy}
            style={styles.spaced}
          />
        ) : null}
      </Card>

      <SectionHeader title="Add manually" />
      <Card>
        <ToggleRow
          label="No mobile authenticator"
          description="For an account that has no maFile. It can browse inventories and handle trade offers, but cannot generate Steam Guard codes or approve confirmations."
          value={noAuthenticator}
          onValueChange={setNoAuthenticator}
        />

        {noAuthenticator ? (
          <Banner
            kind="info"
            message={
              'Steam itself limits these accounts: with no Steam Guard at all an account cannot trade or use the ' +
              'Community Market, and with email Guard only, trades are held for several days. Steam will email a ' +
              'code each time this app signs in.'
            }
          />
        ) : null}

        <Field label="Account name">
          <Input
            value={manual.accountName}
            onChangeText={(value) => setManual((m) => ({ ...m, accountName: value }))}
            placeholder="Steam login name"
          />
        </Field>
        <Field label="SteamID64" hint="17 digits. Needed for confirmations and inventory.">
          <Input
            value={manual.steamId}
            onChangeText={(value) => setManual((m) => ({ ...m, steamId: value }))}
            placeholder="7656119..."
            keyboardType="number-pad"
          />
        </Field>
        {noAuthenticator ? null : (
          <>
            <Field label="shared_secret" hint="Base64. Generates the Steam Guard codes.">
              <Input
                value={manual.sharedSecret}
                onChangeText={(value) => setManual((m) => ({ ...m, sharedSecret: value }))}
                placeholder="base64=="
              />
            </Field>
            <Field label="identity_secret" hint="Base64. Needed to accept trade and market confirmations.">
              <Input
                value={manual.identitySecret}
                onChangeText={(value) => setManual((m) => ({ ...m, identitySecret: value }))}
                placeholder="base64=="
              />
            </Field>
          </>
        )}
        <Field
          label="Steam password (optional)"
          hint="Stored encrypted in the vault, and included in exports if you choose. Lets the app sign in again by itself."
        >
          <Input
            value={manual.password}
            onChangeText={(value) => setManual((m) => ({ ...m, password: value }))}
            secureTextEntry
            placeholder="Optional"
          />
        </Field>

        <Button
          title="Add account"
          onPress={handleManualAdd}
          disabled={!manual.accountName.trim() || (!noAuthenticator && !manual.sharedSecret.trim())}
        />
      </Card>

      <View style={styles.footer}>
        <Text style={typography.caption}>
          Secrets never leave this device except in requests to Steam, and are stored encrypted under
          your master password.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  help: { ...typography.caption, marginTop: spacing.xs, marginBottom: spacing.md, lineHeight: 18 },
  spaced: { marginTop: spacing.sm },
  footer: { marginTop: spacing.lg, paddingHorizontal: spacing.xs },
});
