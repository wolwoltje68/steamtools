// A dark palette in Steam's own blue-grey family, tuned for readability on a
// phone in a dim room.
export const colors = {
  background: '#0e141b',
  surface: '#1b2838',
  surfaceRaised: '#22384f',
  border: '#2f4b6b',
  accent: '#66c0f4',
  accentMuted: '#3f7fa8',
  success: '#5ba32b',
  successMuted: '#2f5a17',
  danger: '#c0392b',
  dangerMuted: '#6b241c',
  warning: '#d9a441',
  text: '#e8eef5',
  textMuted: '#8fa3b8',
  textFaint: '#5f7489',
  overlay: 'rgba(6, 10, 15, 0.85)',
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 };

export const typography = {
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  heading: { fontSize: 17, fontWeight: '600', color: colors.text },
  body: { fontSize: 15, color: colors.text },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.4 },
  caption: { fontSize: 12, color: colors.textMuted },
  mono: { fontSize: 15, color: colors.text, fontVariant: ['tabular-nums'] },
};
