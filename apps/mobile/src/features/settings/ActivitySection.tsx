import type { LibrarySyncFlow } from '@/domain/library-sync-status';
import { makeStyles } from '@/features/settings/layout';
import { Group, Row } from '@/features/settings/presentation';
import type { TFunction } from '@/i18n/translate';
import { usePalette } from '@/theme';
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  View
} from "react-native";
interface Props {
  styles: ReturnType<typeof makeStyles>;
  t: TFunction;
  palette: ReturnType<typeof usePalette>;
  processingSummary: string;
  cloudAvailable: boolean;
  isSyncing: boolean;
  canSync: boolean;
  syncNow: (options?: { force?: boolean; }) => Promise<boolean>;
  offline: boolean;
  librarySyncFlow: LibrarySyncFlow;
  syncPaused: boolean;
  isResettingLibrary: boolean;
  setSyncPaused: (paused: boolean) => void;
}

export function ActivitySection({
  styles,
  t,
  palette,
  processingSummary,
  cloudAvailable,
  isSyncing,
  canSync,
  syncNow,
  offline,
  librarySyncFlow,
  syncPaused,
  isResettingLibrary,
  setSyncPaused,
}: Props) {
  return (<Group styles={styles} title={t("settings.section.activity")}>
    <Row
      styles={styles}
      palette={palette}
      icon="pulse-outline"
      label={t("settings.processing.label")}
      value={processingSummary}
      last
      testID="processing-summary"
      right={
        <View style={styles.syncActions}>
          {cloudAvailable && isSyncing ? (
            <ActivityIndicator color={palette.textSecondary} />
          ) : canSync ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("settings.sync.label")}
              hitSlop={8}
              onPress={() => void syncNow({ force: true })}
              style={({ pressed }) => [
                styles.syncIconButton,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Ionicons name="refresh" size={18} color={palette.accent} />
            </Pressable>
          ) : cloudAvailable && (offline || librarySyncFlow?.phase === "offline") ? (
            <View accessibilityRole="text" accessibilityLiveRegion="polite" accessibilityLabel={t("library.offline")}>
              <Ionicons name="cloud-offline-outline" size={20} color={palette.textSecondary} />
            </View>
          ) : cloudAvailable && !syncPaused ? (
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={palette.success}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              syncPaused
                ? t("settings.sync.resumeButton")
                : t("settings.sync.pauseButton")
            }
            disabled={isResettingLibrary}
            hitSlop={8}
            onPress={() => setSyncPaused(!syncPaused)}
            style={({ pressed }) => [
              styles.syncIconButton,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Ionicons
              name={syncPaused ? "play-circle" : "pause-circle-outline"}
              size={20}
              color={syncPaused ? palette.accent : palette.textSecondary}
            />
          </Pressable>
        </View>
      }
    />
  </Group>);
}
