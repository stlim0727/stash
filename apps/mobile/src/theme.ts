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
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.28,
      shadowRadius: 32,
      elevation: 3,
    },
    soft: {
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.22,
      shadowRadius: 24,
      elevation: 2,
    },
  },
} as const;

export const palettes = {
  light: {
    ...shared,
    text: '#151b26',
    textSecondary: '#5a6070',
    background: '#f7f6f2',
    surface: '#ffffff',
    surfaceElevated: '#ffffff',
    mutedSurface: '#eeede8',
    card: '#ffffff',
    border: '#d8d7d0',
    accent: '#2878d4',
    accentForeground: '#ffffff',
    accentSoft: '#e6f0fc',
    accentText: '#1a5ca8',
    highlight: '#c9941c',
    highlightText: '#ffffff',
    danger: '#c0392b',
    dangerSoft: '#fce8e6',
    success: '#1e7a4e',
    successSoft: '#e3f5ec',
  },
  dark: {
    ...shared,
    text: '#f7f6f2',
    textSecondary: '#aaaeb8',
    background: '#151b26',
    surface: '#202733',
    surfaceElevated: '#202733',
    mutedSurface: '#2a3443',
    card: '#202733',
    border: '#3a4454',
    accent: '#4a98e8',
    accentForeground: '#151b26',
    accentSoft: '#253b50',
    accentText: '#d8ebff',
    highlight: '#eecb69',
    highlightText: '#151b26',
    danger: '#ff8a7a',
    dangerSoft: '#432529',
    success: '#8eddbb',
    successSoft: '#203d33',
  },
} as const;

export type Palette = (typeof palettes)['light'];

export function usePalette() {
  const scheme = useColorScheme();
  return palettes[scheme === 'dark' ? 'dark' : 'light'];
}
