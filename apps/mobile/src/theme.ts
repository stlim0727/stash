import { useColorScheme } from 'react-native';

const palettes = {
  light: {
    text: '#1a1a1a',
    textSecondary: '#60646c',
    card: '#f0f0f3',
    border: '#e0e1e6',
    accent: '#208aef',
  },
  dark: {
    text: '#f5f5f5',
    textSecondary: '#b0b4ba',
    card: '#212225',
    border: '#2e3135',
    accent: '#4ca6f5',
  },
} as const;

export function usePalette() {
  const scheme = useColorScheme();
  return palettes[scheme === 'dark' ? 'dark' : 'light'];
}
