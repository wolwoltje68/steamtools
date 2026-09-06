// Game picker. Shows the appid next to a short name, because two games can
// share a name in conversation but never an appid, and lets a custom appid and
// context id be entered for anything not in the list.
import React, { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { KNOWN_APPS, DEFAULT_CONTEXT_ID } from '../steam/inventory.js';
import { Button, Field, Input } from './components.js';
import { colors, radius, spacing, typography } from './theme.js';

export function AppPicker({ visible, current, onSelect, onClose }) {
  const [customAppId, setCustomAppId] = useState('');
  const [customContextId, setCustomContextId] = useState(DEFAULT_CONTEXT_ID);
  const [error, setError] = useState(null);

  function chooseCustom() {
    const appid = Number(customAppId.trim());
    if (!Number.isInteger(appid) || appid <= 0) {
      setError('Enter a numeric appid, for example 730');
      return;
    }
    const contextid = customContextId.trim() || DEFAULT_CONTEXT_ID;
    if (!/^\d+$/.test(contextid)) {
      setError('The context id must be a number (2 for most games, 6 for Steam items)');
      return;
    }
    setError(null);
    onSelect({ appid, contextid });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={typography.heading}>Choose a game</Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <FlatList
            data={KNOWN_APPS}
            keyExtractor={(item) => `${item.appid}_${item.contextid}`}
            style={styles.list}
            renderItem={({ item }) => {
              const active = Number(current?.appid) === item.appid;
              return (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onSelect({ appid: item.appid, contextid: item.contextid })}
                  style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.pressed]}
                >
                  <Text style={[styles.appid, active && styles.appidActive]}>{item.appid}</Text>
                  <View style={styles.rowText}>
                    <Text style={[typography.body, active && styles.shortActive]}>{item.short}</Text>
                    <Text style={typography.caption} numberOfLines={1}>
                      {item.name}
                    </Text>
                  </View>
                  {active ? <Text style={styles.tick}>✓</Text> : null}
                </Pressable>
              );
            }}
            ListFooterComponent={
              <View style={styles.custom}>
                <Text style={typography.label}>OTHER APPID</Text>
                <View style={styles.customRow}>
                  <View style={styles.customField}>
                  <Field label="appid">
                    <Input
                      value={customAppId}
                      onChangeText={setCustomAppId}
                      placeholder="440"
                      keyboardType="number-pad"
                    />
                  </Field>
                  </View>
                  <View style={styles.customField}>
                  <Field label="context">
                    <Input
                      value={customContextId}
                      onChangeText={setCustomContextId}
                      placeholder="2"
                      keyboardType="number-pad"
                    />
                  </Field>
                  </View>
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Text style={typography.caption}>
                  Most games keep tradable items in context 2. Steam&apos;s own cards, backgrounds and
                  emoticons live in context 6 under appid 753.
                </Text>
                <Button title="Load this app" variant="secondary" onPress={chooseCustom} style={styles.customButton} />
              </View>
            }
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: colors.border,
    maxHeight: '85%',
    paddingTop: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  close: { color: colors.textMuted, fontSize: 18 },
  list: { paddingHorizontal: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowActive: { backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.7 },
  appid: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    minWidth: 62,
    color: colors.textMuted,
    fontWeight: '700',
  },
  appidActive: { color: colors.accent },
  rowText: { flex: 1, gap: 2 },
  shortActive: { color: colors.accent, fontWeight: '700' },
  tick: { color: colors.accent, fontSize: 16, fontWeight: '900' },
  custom: { paddingVertical: spacing.lg, gap: spacing.sm },
  customRow: { flexDirection: 'row', gap: spacing.md },
  customField: { flex: 1 },
  customButton: { marginTop: spacing.sm },
  error: { color: '#f0a49c', fontSize: 12 },
});
