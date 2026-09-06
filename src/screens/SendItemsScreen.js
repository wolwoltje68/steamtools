// Send the selected inventory items to a trade offer URL.
import React, { useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useApp } from '../state/AppContext.js';
import { parseTradeUrl, sendTradeOffer } from '../steam/trades.js';
import { fetchConfirmations, respondToConfirmations, ConfirmationType } from '../steam/confirmations.js';
import { Banner, Button, Card, Field, Input, Pill, Screen, SectionHeader, ToggleRow } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

export default function SendItemsScreen({ route, navigation }) {
  const { activeAccount, ensureSession } = useApp();
  const items = route.params?.items || [];

  const [tradeUrl, setTradeUrl] = useState('');
  const [message, setMessage] = useState('');
  const [confirmAfterSend, setConfirmAfterSend] = useState(!!activeAccount?.identitySecret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const parsed = useMemo(() => {
    if (!tradeUrl.trim()) return null;
    try {
      return { ...parseTradeUrl(tradeUrl), error: null };
    } catch (err) {
      return { error: err.message };
    }
  }, [tradeUrl]);

  const untradable = items.filter((item) => !item.tradable);
  const sendable = items.filter((item) => item.tradable);

  async function pasteUrl() {
    const text = await Clipboard.getStringAsync();
    if (text) setTradeUrl(text.trim());
  }

  async function handleSend() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const account = await ensureSession(activeAccount.id);
      const sent = await sendTradeOffer(account, { tradeUrl, items: sendable, message });

      let confirmed = false;
      if (sent.needsMobileConfirmation && confirmAfterSend && account.identitySecret) {
        // Steam needs a moment before the confirmation appears in the list.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const pending = await fetchConfirmations(account);
        const match = pending.filter(
          (item) => item.type === ConfirmationType.Trade && item.creatorId === sent.tradeOfferId
        );
        if (match.length) {
          await respondToConfirmations(account, match, true);
          confirmed = true;
        }
      }

      setResult({
        tradeOfferId: sent.tradeOfferId,
        needsConfirmation: sent.needsMobileConfirmation && !confirmed,
        confirmed,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) {
    return (
      <Screen>
        <Banner kind="error" message="No items were selected." />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />

      {result ? (
        <Card>
          <Text style={typography.heading}>Offer #{result.tradeOfferId} sent</Text>
          <Text style={styles.help}>
            {result.confirmed
              ? 'It was confirmed automatically and is now waiting for the other person.'
              : result.needsConfirmation
                ? 'It still needs a mobile confirmation. Open the Confirmations tab to approve it.'
                : 'No confirmation was required.'}
          </Text>
          <Button title="Back to inventory" onPress={() => navigation.popToTop()} />
        </Card>
      ) : null}

      <SectionHeader title={`Sending ${sendable.length} item${sendable.length === 1 ? '' : 's'}`} />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
        {items.map((item) => (
          <View key={item.key} style={[styles.thumb, !item.tradable && styles.thumbBlocked]}>
            {item.iconUrl ? <Image source={{ uri: item.iconUrl }} style={styles.thumbImage} /> : null}
          </View>
        ))}
      </ScrollView>

      {untradable.length ? (
        <Banner
          kind="warning"
          message={`${untradable.length} selected item${untradable.length === 1 ? ' is' : 's are'} not tradable and will be left out.`}
        />
      ) : null}

      <Card>
        <Field
          label="Trade offer URL"
          error={parsed?.error}
          hint="From Steam: Inventory → Trade Offers → Who can send me offers."
        >
          <Input
            value={tradeUrl}
            onChangeText={setTradeUrl}
            placeholder="https://steamcommunity.com/tradeoffer/new/?partner=...&token=..."
            multiline
          />
        </Field>
        <Button title="Paste from clipboard" variant="ghost" onPress={pasteUrl} />

        {parsed && !parsed.error ? (
          <View style={styles.parsed}>
            <Pill label={`Partner ${parsed.partnerSteamId}`} tone="accent" />
            {parsed.token ? <Pill label="Token ok" tone="success" /> : <Pill label="No token" tone="danger" />}
          </View>
        ) : null}

        <Field label="Message (optional)">
          <Input value={message} onChangeText={setMessage} placeholder="Attached to the offer" maxLength={128} />
        </Field>

        <ToggleRow
          label="Confirm automatically"
          description={
            activeAccount?.identitySecret
              ? 'Approve the mobile confirmation right after sending.'
              : 'Unavailable: no identity_secret stored for this account.'
          }
          value={confirmAfterSend}
          disabled={!activeAccount?.identitySecret}
          onValueChange={setConfirmAfterSend}
        />
      </Card>

      <Button
        title={`Send ${sendable.length} item${sendable.length === 1 ? '' : 's'}`}
        onPress={handleSend}
        loading={busy}
        disabled={!parsed || !!parsed.error || !parsed.token || sendable.length === 0 || !!result}
      />
      <Text style={styles.footnote}>
        Items leave your account as soon as the other person accepts. Check the partner SteamID above
        before sending.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  thumbs: { gap: spacing.xs, paddingBottom: spacing.md },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  thumbBlocked: { opacity: 0.35, borderColor: colors.warning },
  thumbImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  parsed: { flexDirection: 'row', gap: spacing.xs, marginVertical: spacing.md, flexWrap: 'wrap' },
  help: { ...typography.caption, marginVertical: spacing.sm, lineHeight: 18 },
  footnote: { ...typography.caption, textAlign: 'center', marginTop: spacing.md, lineHeight: 17 },
});
