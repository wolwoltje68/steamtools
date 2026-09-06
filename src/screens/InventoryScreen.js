// Inventory overview with multi-select, feeding the send-items and
// market-listing flows.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import { getInventory, KNOWN_APPS } from '../steam/inventory.js';
import { AccountPicker } from '../ui/AccountPicker.js';
import { Banner, Button, EmptyState, Input, Loading, Pill, Screen } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

const COLUMNS = 3;

export default function InventoryScreen({ navigation }) {
  const { accounts, activeAccount, setActiveAccountId, ensureSession, settings } = useApp();

  const [appId, setAppId] = useState(settings.defaultAppId || 730);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [tradableOnly, setTradableOnly] = useState(false);

  const app = KNOWN_APPS.find((candidate) => candidate.appid === appId) || KNOWN_APPS[0];

  const load = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const account = await ensureSession(activeAccount.id);
      setItems(await getInventory(account, { appid: app.appid, contextid: app.contextid }));
    } catch (err) {
      setError(err.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeAccount, app.appid, app.contextid, ensureSession]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (tradableOnly && !item.tradable) return false;
      if (!needle) return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        item.type.toLowerCase().includes(needle) ||
        item.marketHashName.toLowerCase().includes(needle)
      );
    });
  }, [items, search, tradableOnly]);

  const selectedItems = useMemo(() => items.filter((item) => selected.has(item.key)), [items, selected]);

  const toggle = useCallback((item) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of visible) next.add(item.key);
      return next;
    });
  }, [visible]);

  const invertVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      for (const item of visible) {
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
      }
      return next;
    });
  }, [visible]);

  if (accounts.length === 0) {
    return (
      <Screen>
        <EmptyState icon="🎒" title="No accounts yet" description="Add an account to browse its inventory." />
      </Screen>
    );
  }

  const untradableSelected = selectedItems.filter((item) => !item.tradable).length;
  const unmarketableSelected = selectedItems.filter((item) => !item.marketable).length;

  return (
    <Screen contentStyle={styles.screen}>
      <AccountPicker accounts={accounts} activeId={activeAccount?.id} onSelect={setActiveAccountId} />

      <FlatList
        data={visible}
        keyExtractor={(item) => item.key}
        numColumns={COLUMNS}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.accent} />}
        ListHeaderComponent={
          <View>
            <Banner kind="error" message={error} onDismiss={() => setError(null)} />

            <FlatList
              horizontal
              data={KNOWN_APPS}
              keyExtractor={(entry) => String(entry.appid)}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.apps}
              renderItem={({ item: entry }) => (
                <Pressable
                  onPress={() => setAppId(entry.appid)}
                  style={[styles.appChip, entry.appid === appId && styles.appChipActive]}
                >
                  <Text style={[styles.appLabel, entry.appid === appId && styles.appLabelActive]}>
                    {entry.name}
                  </Text>
                </Pressable>
              )}
            />

            <Input
              value={search}
              onChangeText={setSearch}
              placeholder={`Search ${items.length} items`}
              style={styles.search}
            />

            <View style={styles.toolbar}>
              <Pressable onPress={() => setTradableOnly((value) => !value)} hitSlop={6}>
                <Pill label={tradableOnly ? '✓ Tradable only' : 'Tradable only'} tone={tradableOnly ? 'accent' : 'neutral'} />
              </Pressable>
              <View style={styles.toolbarRight}>
                <Pressable onPress={selectAllVisible} hitSlop={6}>
                  <Text style={styles.toolbarAction}>Select all</Text>
                </Pressable>
                <Pressable onPress={invertVisible} hitSlop={6}>
                  <Text style={styles.toolbarAction}>Invert</Text>
                </Pressable>
                <Pressable onPress={() => setSelected(new Set())} hitSlop={6}>
                  <Text style={styles.toolbarAction}>Clear</Text>
                </Pressable>
              </View>
            </View>
          </View>
        }
        renderItem={({ item }) => (
          <ItemTile item={item} selected={selected.has(item.key)} onPress={() => toggle(item)} />
        )}
        ListEmptyComponent={
          loading ? (
            <Loading label="Loading inventory" />
          ) : (
            <EmptyState
              icon="🎒"
              title={items.length ? 'Nothing matches' : 'Inventory is empty'}
              description={
                items.length
                  ? 'No items match the current search or filter.'
                  : `No ${app.name} items found. The inventory may be private or empty.`
              }
            />
          )
        }
      />

      {selectedItems.length > 0 ? (
        <View style={styles.actionBar}>
          <View style={styles.actionSummary}>
            <Text style={typography.heading}>{selectedItems.length} selected</Text>
            <Text style={typography.caption}>
              {untradableSelected ? `${untradableSelected} not tradable · ` : ''}
              {unmarketableSelected ? `${unmarketableSelected} not marketable` : ''}
              {!untradableSelected && !unmarketableSelected ? 'All tradable and marketable' : ''}
            </Text>
          </View>
          <View style={styles.actionButtons}>
            <Button
              title="Send"
              icon="➤"
              onPress={() => navigation.navigate('SendItems', { items: selectedItems })}
              style={styles.actionButton}
            />
            <Button
              title="Sell"
              icon="🏷"
              variant="secondary"
              onPress={() => navigation.navigate('MarketSell', { items: selectedItems })}
              style={styles.actionButton}
            />
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

const ItemTile = React.memo(function ItemTile({ item, selected, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={item.name}
      style={[styles.tile, selected && styles.tileSelected]}
    >
      <View style={styles.tileImageWrap}>
        {item.iconUrl ? (
          <Image source={{ uri: item.iconUrl }} style={styles.tileImage} />
        ) : (
          <Text style={styles.tileFallback}>?</Text>
        )}
        {item.amount > 1 ? <Text style={styles.amount}>×{item.amount}</Text> : null}
        {selected ? (
          <View style={styles.check}>
            <Text style={styles.checkMark}>✓</Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[styles.tileName, item.nameColor ? { color: item.nameColor } : null]}
        numberOfLines={2}
      >
        {item.name}
      </Text>
      {!item.tradable ? <Text style={styles.tileFlag}>not tradable</Text> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  screen: { padding: 0, paddingBottom: 0 },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 140 },
  column: { gap: spacing.sm, marginBottom: spacing.sm },
  apps: { gap: spacing.xs, paddingBottom: spacing.md },
  appChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  appChipActive: { backgroundColor: colors.accentMuted, borderColor: colors.accent },
  appLabel: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  appLabelActive: { color: colors.text },
  search: { marginBottom: spacing.sm },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  toolbarRight: { flexDirection: 'row', gap: spacing.md },
  toolbarAction: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  tile: {
    flex: 1 / COLUMNS,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  tileSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  tileImageWrap: {
    aspectRatio: 1,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  tileImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  tileFallback: { color: colors.textMuted, fontSize: 20 },
  tileName: { fontSize: 11, color: colors.text, lineHeight: 14 },
  tileFlag: { fontSize: 10, color: colors.warning },
  amount: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    color: colors.text,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 4,
    borderRadius: 4,
    overflow: 'hidden',
  },
  check: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: { color: '#06121c', fontSize: 12, fontWeight: '900' },
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  actionSummary: { gap: 2 },
  actionButtons: { flexDirection: 'row', gap: spacing.sm },
  actionButton: { flex: 1 },
});
