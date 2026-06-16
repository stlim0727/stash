import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { usePalette } from '@/theme';
import { AccountControls } from '@/ui/AccountControls';

export default function AccountScreen() {
  const palette = usePalette();
  const router = useRouter();

  const dismiss = () => {
    if (router.canGoBack()) {
      router.back();
    }
  };

  return (
    <ScrollView
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={styles.container}
    >
      <AccountControls onDone={dismiss} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    gap: 16,
  },
});
