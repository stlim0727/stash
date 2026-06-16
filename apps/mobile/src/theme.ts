import { useColorScheme } from 'react-native';

const shared = {
  radius: {
    sm: 10,
    md: 16,
    lg: 22,
    xl: 28,
    pill: 999,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  shadow: {
    card: {
      shadowColor: '#101828',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 18,
      elevation: 3,
    },
    soft: {
      shadowColor: '#101828',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.05,
      shadowRadius: 12,
      elevation: 2,
    },
  },
} as const;

const palettes = {
  light: {
    ...shared,
    text: '#101828',
    textSecondary: '#667085',
    background: '#f7f9fc',
    surface: '#ffffff',
    surfaceElevated: '#ffffff',
    mutedSurface: '#eef4ff',
    card: '#ffffff',
    border: '#e6eaf0',
    accent: '#208aef',
    accentSoft: '#d9ecff',
    accentText: '#0f5ea8',
    danger: '#d92d20',
    dangerSoft: '#fee4e2',
    success: '#12b76a',
    successSoft: '#dcfae6',
  },
  dark: {
    ...shared,
    text: '#f8fafc',
    textSecondary: '#a7b0c0',
    background: '#0b1220',
    surface: '#151c2c',
    surfaceElevated: '#1b2435',
    mutedSurface: '#102a43',
    card: '#151c2c',
    border: '#2a3548',
    accent: '#4ca6f5',
    accentSoft: '#12395c',
    accentText: '#9ed0ff',
    danger: '#ff6b5f',
    dangerSoft: '#3d1d1d',
    success: '#3ddc97',
    successSoft: '#123628',
  },
} as const;

export type Palette = (typeof palettes)['light'];

export function usePalette() {
  const scheme = useColorScheme();
  return palettes[scheme === 'dark' ? 'dark' : 'light'];
}
