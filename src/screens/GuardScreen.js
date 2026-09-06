// Steam Guard codes for every account, refreshing in step with Steam's clock.
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useApp } from '../state/AppContext.js';
import { generateAuthCode, secondsUntilRotation, CODE_PERIOD_SECONDS } from '../steam/guard.js';
import { steamUnixTime, syncSteamTime, getTimeOffset } from '../steam/time.js';
import { Banner, Card, EmptyState, Pill, Screen } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

export default function GuardScreen() {
  const { accounts } = useApp();
  const [now, setNow] = useState(() => steamUnixTime());
  const [copied, setCopied] = useState(null);
  const [offsetWarning, setOffsetWarning] = useState(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(steamUnixTime()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    syncSteamTime()
      .then(() => {
        const offset = getTimeOffset();
        setOffsetWarning(
          Math.abs(offset) > 30
            ? `This device's clock is ${offset > 0 ? 'behind' : 'ahead'} by ${Math.abs(offset)}s. Codes are corrected automatically.`
            : null
        );
      })
      .catch(() => setOffsetWarning('Could not reach Steam to sync the clock; codes use this device\'s time.'));
  }, []);

  const remaining = secondsUntilRotation(now);

  async function copyCode(account, code) {
    await Clipboard.setStringAsync(code);
    setCopied(account.id);
    setTimeout(() => setCopied((current) => (current === account.id ? null : current)), 1500);
  }

  if (accounts.length === 0) {
    return (
      <Screen>
        <EmptyState
          icon="🔐"
          title="No accounts yet"
          description="Import a maFile or add an account to start generating Steam Guard codes."
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Banner kind="warning" message={offsetWarning} onDismiss={() => setOffsetWarning(null)} />
      {accounts.map((account) => (
        <GuardCard
          key={account.id}
          account={account}
          now={now}
          remaining={remaining}
          copied={copied === account.id}
          onCopy={copyCode}
        />
      ))}
      <Text style={styles.hint}>Tap a code to copy it.</Text>
    </Screen>
  );
}

function GuardCard({ account, now, remaining, copied, onCopy }) {
  const code = useMemo(() => {
    try {
      return generateAuthCode(account.sharedSecret, now);
    } catch (err) {
      return null;
    }
  }, [account.sharedSecret, now]);

  const fraction = remaining / CODE_PERIOD_SECONDS;
  const expiringSoon = remaining <= 5;

  return (
    <Card>
      <View style={styles.header}>
        <View style={styles.identity}>
          <Text style={typography.heading} numberOfLines={1}>
            {account.accountName}
          </Text>
          {account.steamId ? (
            <Text style={typography.caption} numberOfLines={1}>
              {account.steamId}
            </Text>
          ) : null}
        </View>
        {account.identitySecret ? null : <Pill label="No confirmations" tone="warning" />}
      </View>

      {code ? (
        <Pressable onPress={() => onCopy(account, code)} style={styles.codeRow}>
          <Text style={[styles.code, expiringSoon && styles.codeExpiring]}>{code}</Text>
          <Text style={styles.countdown}>{copied ? 'Copied' : `${remaining}s`}</Text>
        </Pressable>
      ) : (
        <Text style={styles.badSecret}>This account’s shared_secret is not valid base64.</Text>
      )}

      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${fraction * 100}%`, backgroundColor: expiringSoon ? colors.warning : colors.accent },
          ]}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  identity: { flex: 1, gap: 2 },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginVertical: spacing.md,
  },
  code: {
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 6,
    color: colors.accent,
    fontVariant: ['tabular-nums'],
  },
  codeExpiring: { color: colors.warning },
  countdown: { ...typography.caption, fontVariant: ['tabular-nums'], minWidth: 54, textAlign: 'right' },
  progressTrack: { height: 3, backgroundColor: colors.background, borderRadius: radius.sm, overflow: 'hidden' },
  progressFill: { height: 3 },
  badSecret: { color: '#f0a49c', marginVertical: spacing.md, fontSize: 13 },
  hint: { ...typography.caption, textAlign: 'center', marginTop: spacing.sm },
});
