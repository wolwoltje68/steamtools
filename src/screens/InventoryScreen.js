// Inventory overview with multi-select, feeding the send-items and
// market-listing flows.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext.js';
import { appById, getInventory } from '../steam/inventory.js';
import { resolveProfile } from '../steam/profile.js';
import { AccountPicker } from '../ui/AccountPicker.js';
import { AppPicker } from '../ui/AppPicker.js';
import { Banner, Button, EmptyState, Input, Loading, Pill, Screen } from '../ui/components.js';
import { colors, radius, spacing, typography } from '../ui/theme.js';

const COLUMNS = 3;

export default function InventoryScreen({ navigation }) {
  const { accounts, activeAccount, setActiveAccountId, ensureSession, settings } = useApp();

  const [app, setApp] = useState(() => appById(settings.defaultAppId || 730));
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [tradableOnly, setTradableOnly] = useState(false);

  // Whose inventory is on screen. null means the signed-in account's own.
  const [owner, setOwner] = useState(null);
  const [ownerInput, setOwnerInput] = useState('');
  const [resolving, setResolving] = useState(false);

  const viewingOther = owner !== null;
  const ownerSteamId = owner?.steamId || activeAccount?.steamId || null;

  const load = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      // Public inventories need no session. Sign in when we can, since a
      // logged-in request gets a more generous rate limit, but fall back to an
      // anonymous request rather than refusing to browse someone else's items.
      let requester = null;
      try {
        requester = await ensureSession(activeAccount.id);
      } catch (err) {
        if (!viewingOther) throw err;
      }
      setItems(
        await getInventory(requester, {
          steamId: ownerSteamId,
          appid: app.appid,
          contextid: app.contextid,
        })
      );
    } catch (err) {
      setError(err.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
    // Keyed on the id: see the note in TradesScreen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount?.id, app.appid, app.contextid, ensureSession, ownerSteamId, viewingOther]);

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

  const loadOwner = useCallback(async () => {
    const text = ownerInput.trim();
    if (!text) return;
    setResolving(true);
    setError(null);
    try {
      let requester = null;
      try {
        requester = await ensureSession(activeAccount.id);
      } catch (err) {
        // Resolving a public profile works fine without a session.
      }
      const profile = await resolveProfile(requester, text);

      // An inventory URL may name the game in its fragment (#730_2).
      if (profile.appid) setApp(appById(profile.appid, profile.contextid));

      if (profile.steamId === activeAccount?.steamId) {
        setOwner(null); // they pasted their own profile
      } else {
        setOwner(profile);
      }
      setOwnerInput('');
    } catch (err) {
      setError(err.message);
    } finally {
      setResolving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerInput, activeAccount?.id, activeAccount?.steamId, ensureSession]);

  const backToMine = useCallback(() => {
    setOwner(null);
    setOwnerInput('');
    setError(null);
  }, []);

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

            <View style={styles.controls}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Change game, currently ${app.appid} ${app.short}`}
                onPress={() => setAppPickerOpen(true)}
                style={({ pressed }) => [styles.appsButton, pressed && styles.pressed]}
              >
                <Text style={styles.appsId}>{app.appid}</Text>
                <Text style={styles.appsShort} numberOfLines={1}>
                  {app.short}
                </Text>
                <Text style={styles.appsChevron}>▾</Text>
              </Pressable>

              <Pill
                label={viewingOther ? owner.displayName : 'Your inventory'}
                tone={viewingOther ? 'warning' : 'accent'}
                style={styles.ownerPill}
              />
            </View>

            <View style={styles.ownerRow}>
              <Input
                value={ownerInput}
                onChangeText={setOwnerInput}
                placeholder="SteamID64, profile URL or name"
                style={styles.ownerInput}
                onSubmitEditing={loadOwner}
                returnKeyType="go"
                autoCapitalize="none"
              />
              <Button
                title="Load"
                onPress={loadOwner}
                loading={resolving}
                disabled={!ownerInput.trim()}
                style={styles.ownerButton}
              />
            </View>

            {viewingOther ? (
              <Banner
                kind="warning"
                message={`Viewing ${owner.displayName}'s inventory. It is read-only: you can only send or sell items you own. To trade with them, go back to your own inventory, select items and paste their trade offer URL.`}
              />
            ) : null}

            {viewingOther ? (
              <Button
                title="Back to my inventory"
                variant="ghost"
                onPress={backToMine}
                style={styles.backButton}
              />
            ) : null}

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
                  : `No ${app.short} items in ${viewingOther ? `${owner.displayName}'s` : 'your'} inventory. ` +
                    'It may be empty, or set to private.'
              }
            />
          )
        }
      />

      {selectedItems.length > 0 && !viewingOther ? (
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
      <AppPicker
        visible={appPickerOpen}
        current={app}
        onClose={() => setAppPickerOpen(false)}
        onSelect={(choice) => {
          setApp(appById(choice.appid, choice.contextid));
          setAppPickerOpen(false);
        }}
      />
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
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  appsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  appsId: {
    ...typography.caption,
    color: colors.accent,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  appsShort: { color: colors.text, fontSize: 14, fontWeight: '700', maxWidth: 130 },
  appsChevron: { color: colors.textMuted, fontSize: 11 },
  ownerPill: { flexShrink: 1 },
  pressed: { opacity: 0.7 },
  ownerRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  ownerInput: { flex: 1 },
  ownerButton: { paddingHorizontal: spacing.lg },
  backButton: { marginBottom: spacing.sm },
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
