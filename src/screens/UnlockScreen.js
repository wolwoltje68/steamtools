// Vault setup and unlock. This is the only gate to any stored secret.
import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import { Banner, Button, Field, Input, ToggleRow } from '../ui/components.js';
import { colors, spacing, typography } from '../ui/theme.js';

export default function UnlockScreen() {
  const { status, createVault, unlock, unlockProgress } = useApp();
  const isSetup = status === 'setup';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
  }, [isSetup]);

  async function handleSubmit() {
    setError(null);
    if (isSetup && password !== confirmPassword) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    try {
      if (isSetup) await createVault(password, remember);
      else await unlock(password, remember);
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  const percent = Math.round(unlockProgress * 100);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.logo}>SteamTools</Text>
        <Text style={styles.tagline}>
          {isSetup
            ? 'Pick a master password. It encrypts every account, secret and password on this device.'
            : 'Enter your master password to unlock the vault.'}
        </Text>

        <Banner kind="error" message={error} onDismiss={() => setError(null)} />

        <Field label="Master password">
          <Input
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="At least 6 characters"
            autoFocus
            onSubmitEditing={isSetup ? undefined : handleSubmit}
            returnKeyType={isSetup ? 'next' : 'go'}
          />
        </Field>

        {isSetup ? (
          <Field
            label="Repeat master password"
            hint="There is no recovery. If you forget this password the vault cannot be opened."
          >
            <Input
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              secureTextEntry
              placeholder="Repeat it"
              onSubmitEditing={handleSubmit}
              returnKeyType="go"
            />
          </Field>
        ) : null}

        <ToggleRow
          label="Remember on this device"
          description="Stores the master password in the device keystore, protected by your screen lock."
          value={remember}
          onValueChange={setRemember}
        />

        {busy && percent > 0 && percent < 100 ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>
        ) : null}

        <Button
          title={isSetup ? 'Create vault' : 'Unlock'}
          onPress={handleSubmit}
          loading={busy}
          disabled={password.length < 6}
          style={styles.submit}
        />

        <Text style={styles.footnote}>
          Secrets are encrypted with AES-256 using a key derived from this password. Nothing is sent
          anywhere except to Steam itself.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl, paddingTop: spacing.xxl * 2, flexGrow: 1, justifyContent: 'center' },
  logo: { ...typography.title, fontSize: 32, color: colors.accent, textAlign: 'center' },
  tagline: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    lineHeight: 19,
  },
  submit: { marginTop: spacing.md },
  footnote: { ...typography.caption, textAlign: 'center', marginTop: spacing.xl, lineHeight: 17 },
  progressTrack: {
    height: 4,
    backgroundColor: colors.surfaceRaised,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  progressFill: { height: 4, backgroundColor: colors.accent },
});
