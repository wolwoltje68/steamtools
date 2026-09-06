// Shared presentational building blocks.
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, spacing, typography } from './theme.js';

export function Screen({ children, scroll = false, refreshControl, contentStyle }) {
  const Inner = scroll ? ScrollView : View;
  const innerProps = scroll
    ? { contentContainerStyle: [styles.screenContent, contentStyle], refreshControl, keyboardShouldPersistTaps: 'handled' }
    : { style: [styles.screenContent, contentStyle] };
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      <Inner {...innerProps}>{children}</Inner>
    </SafeAreaView>
  );
}

export function Card({ children, style, onPress }) {
  const Container = onPress ? Pressable : View;
  return (
    <Container
      style={({ pressed } = {}) => [styles.card, style, pressed && styles.pressed]}
      onPress={onPress}
    >
      {children}
    </Container>
  );
}

export function SectionHeader({ title, action, onAction }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={typography.label}>{String(title).toUpperCase()}</Text>
      {action ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, loading, style, icon }) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        variantStyles[variant],
        isDisabled && styles.buttonDisabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.background : colors.text} size="small" />
      ) : (
        <Text style={[styles.buttonText, variant === 'primary' && styles.buttonTextPrimary]}>
          {icon ? `${icon}  ` : ''}
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  danger: { backgroundColor: colors.dangerMuted, borderColor: colors.danger },
  success: { backgroundColor: colors.successMuted, borderColor: colors.success },
  ghost: { backgroundColor: 'transparent', borderColor: colors.border },
});

export function Field({ label, hint, error, children }) {
  return (
    <View style={styles.field}>
      {label ? <Text style={typography.label}>{label.toUpperCase()}</Text> : null}
      {children}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      {hint && !error ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Input(props) {
  return (
    <TextInput
      placeholderTextColor={colors.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={[styles.input, props.multiline && styles.inputMultiline, props.style]}
    />
  );
}

export function ToggleRow({ label, description, value, onValueChange, disabled }) {
  return (
    <View style={[styles.toggleRow, disabled && styles.toggleDisabled]}>
      <View style={styles.toggleText}>
        <Text style={typography.body}>{label}</Text>
        {description ? <Text style={styles.toggleDescription}>{description}</Text> : null}
      </View>
      <Switch
        value={!!value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.accentMuted }}
        thumbColor={value ? colors.accent : colors.textMuted}
      />
    </View>
  );
}

export function Banner({ kind = 'info', message, onDismiss }) {
  if (!message) return null;
  const tone = {
    info: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
    error: { backgroundColor: colors.dangerMuted, borderColor: colors.danger },
    success: { backgroundColor: colors.successMuted, borderColor: colors.success },
    warning: { backgroundColor: '#4a3a12', borderColor: colors.warning },
  }[kind];

  return (
    <Pressable onPress={onDismiss} style={[styles.banner, tone]}>
      <Text style={styles.bannerText}>{message}</Text>
      {onDismiss ? <Text style={styles.bannerDismiss}>✕</Text> : null}
    </Pressable>
  );
}

export function EmptyState({ icon = '∅', title, description, action, onAction }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {description ? <Text style={styles.emptyDescription}>{description}</Text> : null}
      {action ? <Button title={action} onPress={onAction} variant="secondary" style={styles.emptyAction} /> : null}
    </View>
  );
}

export function Loading({ label }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.accent} size="large" />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
    </View>
  );
}

export function Pill({ label, tone = 'neutral', style }) {
  const tones = {
    neutral: { backgroundColor: colors.surfaceRaised, color: colors.textMuted },
    accent: { backgroundColor: colors.accentMuted, color: colors.text },
    success: { backgroundColor: colors.successMuted, color: '#b7e08c' },
    danger: { backgroundColor: colors.dangerMuted, color: '#f0a49c' },
    warning: { backgroundColor: '#4a3a12', color: colors.warning },
  }[tone];

  return (
    <View style={[styles.pill, { backgroundColor: tones.backgroundColor }, style]}>
      <Text style={[styles.pillText, { color: tones.color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  screenContent: { padding: spacing.lg, paddingBottom: spacing.xxl, flexGrow: 1 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  pressed: { opacity: 0.7 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionAction: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  button: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  buttonTextPrimary: { color: '#06121c' },
  field: { marginBottom: spacing.md, gap: spacing.xs },
  fieldError: { color: '#f0a49c', fontSize: 12 },
  fieldHint: { color: colors.textMuted, fontSize: 12 },
  input: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  toggleDisabled: { opacity: 0.45 },
  toggleText: { flex: 1, gap: 2 },
  toggleDescription: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerText: { color: colors.text, flex: 1, fontSize: 14, lineHeight: 19 },
  bannerDismiss: { color: colors.textMuted, fontSize: 14 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xxl, gap: spacing.sm, flex: 1 },
  emptyIcon: { fontSize: 40, color: colors.border },
  emptyTitle: { ...typography.heading, textAlign: 'center' },
  emptyDescription: { ...typography.caption, textAlign: 'center', maxWidth: 300, lineHeight: 18 },
  emptyAction: { marginTop: spacing.md, alignSelf: 'stretch' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  loadingLabel: { ...typography.caption },
  pill: { borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  pillText: { fontSize: 11, fontWeight: '600' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
});
