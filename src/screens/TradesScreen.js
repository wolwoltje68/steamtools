// Incoming and outgoing trade offers, with accept / decline.
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Image, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import { acceptTradeOffer, declineTradeOffer, getTradeOffers } from '../steam/trades.js';
import { itemImageUrl } from '../steam/inventory.js';
import { AccountPicker } from '../ui/AccountPicker.js';
import { Banner, Button, Card, EmptyState, Loading, Pill, Screen, SectionHeader } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

export default function TradesScreen() {
  const { accounts, activeAccount, setActiveAccountId, ensureSession } = useApp();
  const [offers, setOffers] = useState({ received: [], sent: [] });
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
      setOffers(await getTradeOffers(account, { activeOnly: true }));
    } catch (err) {
      setError(err.message);
      setOffers({ received: [], sent: [] });
    } finally {
      setLoading(false);
    }
    // Keyed on the id, not the account object: ensureSession rewrites the
    // account after renewing a token, and depending on its identity would
    // re-trigger this load on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount?.id, ensureSession]);

  useEffect(() => {
    load();
  }, [load]);

  async function respond(offer, accept) {
    setBusyId(offer.id);
    setError(null);
    try {
      const account = await ensureSession(activeAccount.id);
      if (accept) {
        const result = await acceptTradeOffer(account, offer);
        setNotice(
          result.needsMobileConfirmation
            ? 'Accepted. It still needs a mobile confirmation - open the Confirmations tab.'
            : 'Trade accepted.'
        );
      } else {
        await declineTradeOffer(account, offer);
        setNotice(offer.direction === 'sent' ? 'Offer cancelled.' : 'Offer declined.');
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function confirmAccept(offer) {
    if (offer.itemsToGive.length === 0) {
      respond(offer, true);
      return;
    }
    Alert.alert(
      'Accept this trade?',
      `You give ${offer.itemsToGive.length} item(s) and receive ${offer.itemsToReceive.length}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Accept', onPress: () => respond(offer, true) },
      ]
    );
  }

  if (accounts.length === 0) {
    return (
      <Screen>
        <EmptyState icon="🔄" title="No accounts yet" description="Add an account to see its trade offers." />
      </Screen>
    );
  }

  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}>
      <AccountPicker accounts={accounts} activeId={activeAccount?.id} onSelect={setActiveAccountId} />
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="success" message={notice} onDismiss={() => setNotice(null)} />

      {loading && offers.received.length === 0 && offers.sent.length === 0 ? (
        <Loading label="Loading trade offers" />
      ) : null}

      <SectionHeader title={`Incoming (${offers.received.length})`} />
      {offers.received.length === 0 && !loading ? (
        <Text style={styles.none}>No incoming offers.</Text>
      ) : (
        offers.received.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            busy={busyId === offer.id}
            onAccept={() => confirmAccept(offer)}
            onDecline={() => respond(offer, false)}
          />
        ))
      )}

      <SectionHeader title={`Sent (${offers.sent.length})`} />
      {offers.sent.length === 0 && !loading ? (
        <Text style={styles.none}>No outgoing offers.</Text>
      ) : (
        offers.sent.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            busy={busyId === offer.id}
            onDecline={() => respond(offer, false)}
          />
        ))
      )}
    </Screen>
  );
}

function OfferCard({ offer, busy, onAccept, onDecline }) {
  const isGift = offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0;

  return (
    <Card>
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={typography.heading}>
            {offer.direction === 'received' ? 'From' : 'To'} {offer.partnerSteamId}
          </Text>
          <Text style={typography.caption}>
            {offer.message ? `"${offer.message}" · ` : ''}
            {formatAge(offer.createdAt)}
          </Text>
        </View>
        <View style={styles.headerBadges}>
          {isGift ? <Pill label="Gift" tone="success" /> : null}
          {offer.escrowDays ? <Pill label="Escrow" tone="warning" /> : null}
          <Pill label={offer.stateName} />
        </View>
      </View>

      <ItemStrip label={`You give (${offer.itemsToGive.length})`} items={offer.itemsToGive} />
      <ItemStrip label={`You receive (${offer.itemsToReceive.length})`} items={offer.itemsToReceive} />

      <View style={styles.actions}>
        {onAccept ? (
          <Button title="Accept" onPress={onAccept} loading={busy} style={styles.action} />
        ) : null}
        <Button
          title={offer.direction === 'sent' ? 'Cancel' : 'Decline'}
          variant="danger"
          onPress={onDecline}
          loading={busy && !onAccept}
          style={styles.action}
        />
      </View>
    </Card>
  );
}

function ItemStrip({ label, items }) {
  return (
    <View style={styles.strip}>
      <Text style={typography.label}>{label.toUpperCase()}</Text>
      {items.length === 0 ? (
        <Text style={styles.nothing}>nothing</Text>
      ) : (
        <View style={styles.thumbs}>
          {items.slice(0, 10).map((item, index) => (
            <View key={`${item.assetid}-${index}`} style={styles.thumb}>
              {item.iconUrl ? (
                <Image source={{ uri: itemImageUrl(item.iconUrl, '96fx96f') }} style={styles.thumbImage} />
              ) : (
                <Text style={styles.thumbFallback}>?</Text>
              )}
            </View>
          ))}
          {items.length > 10 ? <Text style={styles.more}>+{items.length - 10}</Text> : null}
        </View>
      )}
    </View>
  );
}

function formatAge(unixSeconds) {
  if (!unixSeconds) return 'unknown time';
  const minutes = Math.floor((Date.now() / 1000 - unixSeconds) / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  headerText: { flex: 1, gap: 2 },
  headerBadges: { alignItems: 'flex-end', gap: spacing.xs },
  strip: { marginTop: spacing.md, gap: spacing.xs },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImage: { width: 44, height: 44, resizeMode: 'contain' },
  thumbFallback: { color: colors.textMuted },
  more: { ...typography.caption, marginLeft: spacing.xs },
  nothing: { ...typography.caption, fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  action: { flex: 1 },
  none: { ...typography.caption, paddingVertical: spacing.sm },
});
