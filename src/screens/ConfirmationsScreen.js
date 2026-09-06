// Pending mobile confirmations, individually or in bulk.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Image, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import {
  ConfirmationType,
  fetchConfirmations,
  respondToConfirmation,
  respondToConfirmations,
} from '../steam/confirmations.js';
import { AccountPicker } from '../ui/AccountPicker.js';
import { Banner, Button, Card, EmptyState, Loading, Pill, Screen } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

export default function ConfirmationsScreen() {
  const { accounts, activeAccount, setActiveAccountId, ensureSession } = useApp();
  const [confirmations, setConfirmations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    setError(null);
    try {
      const account = await ensureSession(activeAccount.id);
      setConfirmations(await fetchConfirmations(account));
    } catch (err) {
      setError(err.message);
      setConfirmations([]);
    } finally {
      setLoading(false);
    }
  }, [activeAccount, ensureSession]);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(confirmation, accept) {
    setBusyId(confirmation.id);
    setError(null);
    try {
      const account = await ensureSession(activeAccount.id);
      await respondToConfirmation(account, confirmation, accept);
      setConfirmations((current) => current.filter((item) => item.id !== confirmation.id));
      setNotice(accept ? 'Confirmed.' : 'Cancelled.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function respondAll(accept) {
    setLoading(true);
    setError(null);
    try {
      const account = await ensureSession(activeAccount.id);
      await respondToConfirmations(account, confirmations, accept);
      setNotice(`${accept ? 'Confirmed' : 'Cancelled'} ${confirmations.length}.`);
      setConfirmations([]);
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setLoading(false);
    }
  }

  function confirmAll() {
    const risky = confirmations.filter(
      (item) => item.type !== ConfirmationType.Trade && item.type !== ConfirmationType.MarketListing
    );
    const warning = risky.length
      ? `\n\nWarning: ${risky.length} of these are account-level changes (${risky
          .map((item) => item.typeName)
          .join(', ')}).`
      : '';
    Alert.alert('Confirm all?', `This approves ${confirmations.length} pending confirmations.${warning}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm all', onPress: () => respondAll(true) },
    ]);
  }

  if (accounts.length === 0) {
    return (
      <Screen>
        <EmptyState icon="✅" title="No accounts yet" description="Add an account to see its confirmations." />
      </Screen>
    );
  }

  if (activeAccount && !activeAccount.identitySecret) {
    return (
      <Screen scroll>
        <AccountPicker accounts={accounts} activeId={activeAccount?.id} onSelect={setActiveAccountId} />
        <EmptyState
          icon="🔑"
          title="No identity_secret"
          description={`${activeAccount.accountName} has no identity_secret stored, so Steam confirmations cannot be signed. Import a complete maFile for this account.`}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}>
      <AccountPicker accounts={accounts} activeId={activeAccount?.id} onSelect={setActiveAccountId} />
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="success" message={notice} onDismiss={() => setNotice(null)} />

      {loading && confirmations.length === 0 ? <Loading label="Loading confirmations" /> : null}

      {confirmations.length > 1 ? (
        <View style={styles.bulk}>
          <Button title={`Confirm all ${confirmations.length}`} onPress={confirmAll} style={styles.bulkButton} />
          <Button
            title="Cancel all"
            variant="danger"
            onPress={() => respondAll(false)}
            style={styles.bulkButton}
          />
        </View>
      ) : null}

      {!loading && confirmations.length === 0 ? (
        <EmptyState icon="✓" title="Nothing pending" description="No confirmations are waiting for this account." />
      ) : null}

      {confirmations.map((confirmation) => (
        <Card key={confirmation.id}>
          <View style={styles.row}>
            {confirmation.icon ? (
              <Image source={{ uri: confirmation.icon }} style={styles.icon} />
            ) : null}
            <View style={styles.text}>
              <Text style={typography.heading} numberOfLines={2}>
                {confirmation.headline || confirmation.typeName}
              </Text>
              {confirmation.summary.map((line, index) => (
                <Text key={index} style={typography.caption}>
                  {line}
                </Text>
              ))}
            </View>
            <Pill
              label={confirmation.typeName}
              tone={
                confirmation.type === ConfirmationType.Trade
                  ? 'accent'
                  : confirmation.type === ConfirmationType.MarketListing
                    ? 'neutral'
                    : 'warning'
              }
            />
          </View>

          {confirmation.warn ? <Banner kind="warning" message={confirmation.warn} /> : null}

          <View style={styles.actions}>
            <Button
              title={confirmation.acceptLabel}
              onPress={() => respond(confirmation, true)}
              loading={busyId === confirmation.id}
              style={styles.action}
            />
            <Button
              title={confirmation.cancelLabel}
              variant="danger"
              onPress={() => respond(confirmation, false)}
              style={styles.action}
            />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  icon: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.background },
  text: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  action: { flex: 1 },
  bulk: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  bulkButton: { flex: 1 },
});
