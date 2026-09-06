// Horizontal account switcher shown at the top of the per-account screens.
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { colors, radius, spacing } from './theme.js';

export function AccountPicker({ accounts, activeId, onSelect }) {
  if (accounts.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroller}
    >
      {accounts.map((account) => {
        const active = account.id === activeId;
        return (
          <Pressable
            key={account.id}
            onPress={() => onSelect(account.id)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {account.accountName}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: { flexGrow: 0, marginBottom: spacing.md },
  row: { gap: spacing.xs, paddingRight: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accentMuted, borderColor: colors.accent },
  label: { color: colors.textMuted, fontSize: 13, fontWeight: '600', maxWidth: 160 },
  labelActive: { color: colors.text },
});
