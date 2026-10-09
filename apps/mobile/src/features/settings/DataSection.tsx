import { makeStyles } from '@/features/settings/layout';
import { Group, Row } from '@/features/settings/presentation';
import type { TFunction } from '@/i18n/translate';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import { usePalette } from '@/theme';
import type { Dispatch, SetStateAction } from 'react';
import {
  ActivityIndicator
} from "react-native";
interface Props {
  styles: ReturnType<typeof makeStyles>;
  t: TFunction;
  palette: ReturnType<typeof usePalette>;
  exporting: boolean;
  totalBookmarks: number;
  isResettingLibrary: boolean;
  setExportSheetOpen: Dispatch<SetStateAction<boolean>>;
  importing: boolean;
  setImportSheetOpen: Dispatch<SetStateAction<boolean>>;
  auth: ReturnType<typeof useSupabaseAuth>;
  setResetError: Dispatch<SetStateAction<string | null>>;
  setResetDialogOpen: Dispatch<SetStateAction<boolean>>;
}

export function DataSection({
  styles,
  t,
  palette,
  exporting,
  totalBookmarks,
  isResettingLibrary,
  setExportSheetOpen,
  importing,
  setImportSheetOpen,
  auth,
  setResetError,
  setResetDialogOpen,
}: Props) {
  return (<Group
    styles={styles}
    title={t("settings.section.data")}
    footnote={t("settings.dataNote")}
  >
    <Row
      styles={styles}
      palette={palette}
      icon="download-outline"
      label={t("settings.export.label")}
      value={
        exporting
          ? t("settings.export.preparing")
          : totalBookmarks === 0
            ? t("settings.export.nothing")
            : t("settings.export.value")
      }
      right={
        exporting ? (
          <ActivityIndicator color={palette.textSecondary} />
        ) : undefined
      }
      onPress={
        exporting || isResettingLibrary || totalBookmarks === 0
          ? undefined
          : () => setExportSheetOpen(true)
      }
    />
    <Row
      styles={styles}
      palette={palette}
      icon="enter-outline"
      label={t("settings.import.label")}
      value={
        importing
          ? t("settings.import.importing")
          : t("settings.import.value")
      }
      right={
        importing ? (
          <ActivityIndicator color={palette.textSecondary} />
        ) : undefined
      }
      onPress={
        importing || isResettingLibrary
          ? undefined
          : () => setImportSheetOpen(true)
      }
    />
    {/* Destructive library reset (issue #600): online-only, type-to-confirm.
            Disabled without a usable session — the wipe is a cloud RPC. */}
    <Row
      styles={styles}
      palette={palette}
      icon="nuclear-outline"
      label={t("settings.reset.label")}
      value={
        isResettingLibrary
          ? t("settings.reset.resetting")
          : auth.isSignedIn
            ? t("settings.reset.value")
            : t("settings.reset.signInRequired")
      }
      last
      disabled={!auth.isSignedIn}
      right={
        isResettingLibrary ? (
          <ActivityIndicator color={palette.textSecondary} />
        ) : undefined
      }
      onPress={
        !auth.isSignedIn || isResettingLibrary || importing || exporting
          ? undefined
          : () => {
            setResetError(null);
            setResetDialogOpen(true);
          }
      }
    />
  </Group>);
}
