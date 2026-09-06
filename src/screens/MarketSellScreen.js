// List the selected items on the Steam Community Market.
import React, { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import {
  createSellListing,
  currencyById,
  estimateFees,
  formatPrice,
  getPriceOverview,
  parsePriceToCents,
  receivedFromBuyerPays,
} from '../steam/market.js';
import { fetchConfirmations, respondToConfirmations, ConfirmationType } from '../steam/confirmations.js';
import { Banner, Button, Card, Divider, Field, Input, Pill, Screen, SectionHeader, ToggleRow } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

export default function MarketSellScreen({ route, navigation }) {
  const { activeAccount, ensureSession, settings } = useApp();
  const currency = settings.currency || 3;
  const marketable = (route.params?.items || []).filter((item) => item.marketable);

  const [prices, setPrices] = useState({}); // marketHashName -> overview
  const [buyerPays, setBuyerPays] = useState({}); // item.key -> text
  const [loadingPrices, setLoadingPrices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [confirmAfter, setConfirmAfter] = useState(!!activeAccount?.identitySecret);
  const [done, setDone] = useState(null);
  const [undercutCents, setUndercutCents] = useState('1');

  const loadPrices = useCallback(async () => {
    if (marketable.length === 0) return;
    setLoadingPrices(true);
    setError(null);
    try {
      const account = await ensureSession(activeAccount.id);
      const unique = [...new Set(marketable.map((item) => item.marketHashName).filter(Boolean))];
      const found = {};
      for (const name of unique) {
        try {
          const appid = marketable.find((item) => item.marketHashName === name).appid;
          found[name] = await getPriceOverview(account, { appid, marketHashName: name, currency });
        } catch (err) {
          found[name] = null;
        }
        // Steam rate-limits priceoverview hard; pace the lookups.
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      setPrices(found);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingPrices(false);
    }
  }, [activeAccount, currency, ensureSession, marketable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadPrices();
  }, [loadPrices]);

  /** Fill every empty price field with the lowest listing minus the undercut. */
  function applySuggested() {
    const undercut = Math.max(0, Number(undercutCents) || 0);
    const next = { ...buyerPays };
    for (const item of marketable) {
      const overview = prices[item.marketHashName];
      if (!overview?.lowestPriceCents) continue;
      const target = Math.max(3, overview.lowestPriceCents - undercut);
      next[item.key] = (target / 100).toFixed(2);
    }
    setBuyerPays(next);
  }

  async function listAll() {
    setBusy(true);
    setError(null);
    const created = [];
    const failures = [];

    try {
      const account = await ensureSession(activeAccount.id);

      for (let index = 0; index < marketable.length; index++) {
        const item = marketable[index];
        setProgress(`Listing ${index + 1} of ${marketable.length}...`);

        const buyerCents = parsePriceToCents(buyerPays[item.key]);
        if (!buyerCents) {
          failures.push(`${item.name}: no price entered`);
          continue;
        }
        const receives = receivedFromBuyerPays(buyerCents);
        try {
          await createSellListing(account, {
            appid: item.appid,
            contextid: item.contextid,
            assetid: item.assetid,
            amount: 1,
            receivesCents: receives,
          });
          created.push(item.name);
        } catch (err) {
          failures.push(`${item.name}: ${err.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (created.length && confirmAfter && account.identitySecret) {
        setProgress('Confirming listings...');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const pending = await fetchConfirmations(account);
        const listings = pending.filter((item) => item.type === ConfirmationType.MarketListing);
        if (listings.length) await respondToConfirmations(account, listings, true);
      }

      setProgress(null);
      if (failures.length) setError(failures.join('\n'));
      if (created.length) setDone({ count: created.length, confirmed: confirmAfter });
    } catch (err) {
      setError(err.message);
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  if (marketable.length === 0) {
    return (
      <Screen>
        <Banner kind="warning" message="None of the selected items can be sold on the Community Market." />
      </Screen>
    );
  }

  const total = marketable.reduce((sum, item) => {
    const cents = parsePriceToCents(buyerPays[item.key]);
    return cents ? sum + receivedFromBuyerPays(cents) : sum;
  }, 0);

  return (
    <Screen scroll>
      <Banner kind="error" message={error} onDismiss={() => setError(null)} />
      <Banner kind="info" message={progress} />

      {done ? (
        <Card>
          <Text style={typography.heading}>
            Listed {done.count} item{done.count === 1 ? '' : 's'}
          </Text>
          <Text style={styles.footnote}>
            {done.confirmed
              ? 'The market confirmations were approved automatically.'
              : 'Open the Confirmations tab to approve them.'}
          </Text>
          <Button title="Back to inventory" onPress={() => navigation.popToTop()} />
        </Card>
      ) : null}

      <SectionHeader
        title={`${marketable.length} item${marketable.length === 1 ? '' : 's'} to list`}
        action={loadingPrices ? 'Loading prices…' : 'Refresh prices'}
        onAction={loadingPrices ? undefined : loadPrices}
      />

      <Card>
        <Field label="Undercut lowest by (cents)">
          <Input value={undercutCents} onChangeText={setUndercutCents} keyboardType="number-pad" />
        </Field>
        <Button title="Fill prices from market" variant="secondary" onPress={applySuggested} disabled={loadingPrices} />
      </Card>

      {marketable.map((item) => (
        <PriceRow
          key={item.key}
          item={item}
          overview={prices[item.marketHashName]}
          currency={currency}
          value={buyerPays[item.key] || ''}
          onChange={(value) => setBuyerPays((current) => ({ ...current, [item.key]: value }))}
        />
      ))}

      <Card>
        <View style={styles.totalRow}>
          <Text style={typography.heading}>You receive in total</Text>
          <Text style={styles.total}>{formatPrice(total, currency)}</Text>
        </View>
        <Divider />
        <ToggleRow
          label="Confirm listings automatically"
          description={
            activeAccount?.identitySecret
              ? 'Approve the market confirmations right after listing.'
              : 'Unavailable: no identity_secret stored for this account.'
          }
          value={confirmAfter}
          disabled={!activeAccount?.identitySecret}
          onValueChange={setConfirmAfter}
        />
      </Card>

      <Button
        title={`List ${marketable.length} item${marketable.length === 1 ? '' : 's'}`}
        onPress={listAll}
        loading={busy}
        disabled={!!done}
      />
      <Text style={styles.footnote}>
        Prices are what the buyer pays. Steam’s cut is an estimate, since the publisher fee differs
        per game.
      </Text>
    </Screen>
  );
}

function PriceRow({ item, overview, currency, value, onChange }) {
  const buyerCents = parsePriceToCents(value);
  const receives = buyerCents ? receivedFromBuyerPays(buyerCents) : 0;
  const fees = estimateFees(receives);
  const { symbol } = currencyById(currency);

  return (
    <Card>
      <View style={styles.itemRow}>
        {item.iconUrl ? <Image source={{ uri: item.iconUrl }} style={styles.icon} /> : null}
        <View style={styles.itemText}>
          <Text style={typography.body} numberOfLines={2}>
            {item.name}
          </Text>
          {overview ? (
            <Text style={typography.caption}>
              lowest {overview.lowestPriceCents ? formatPrice(overview.lowestPriceCents, currency) : '—'}
              {overview.medianPriceCents ? ` · median ${formatPrice(overview.medianPriceCents, currency)}` : ''}
              {overview.volume ? ` · ${overview.volume} sold/day` : ''}
            </Text>
          ) : (
            <Text style={typography.caption}>{overview === null ? 'No price data' : 'Loading price…'}</Text>
          )}
        </View>
      </View>

      <View style={styles.priceRow}>
        <Text style={styles.currency}>{symbol}</Text>
        <Input
          value={value}
          onChangeText={onChange}
          placeholder="0.00"
          keyboardType="decimal-pad"
          style={styles.priceInput}
        />
        <Pill label={`you get ${formatPrice(receives, currency)}`} tone={receives ? 'success' : 'neutral'} />
      </View>
      {buyerCents ? (
        <Text style={styles.feeLine}>
          buyer pays {formatPrice(buyerCents, currency)} · fees {formatPrice(fees.steamFee + fees.publisherFee, currency)}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  itemRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  icon: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: colors.background, resizeMode: 'contain' },
  itemText: { flex: 1, gap: 2 },
  priceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
  currency: { ...typography.body, color: colors.textMuted },
  priceInput: { flex: 1 },
  feeLine: { ...typography.caption, marginTop: spacing.xs },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { ...typography.title, color: colors.success },
  footnote: { ...typography.caption, textAlign: 'center', marginTop: spacing.md, lineHeight: 17 },
});
