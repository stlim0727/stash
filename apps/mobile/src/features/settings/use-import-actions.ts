import type { ImportItem } from '@/domain/import';
import { parseImport } from "@/domain/import";
import type { TFunction } from '@/i18n/translate';
import { pickImportFile } from "@/share/import-data";
import type { ImportSummary } from '@/store/bookmarks';
import { useState } from "react";
import {
  Alert
} from "react-native";

interface Dependencies {
  importBookmarks: (items: ImportItem[]) => ImportSummary;
  t: TFunction;
}

export function useImportActions({ importBookmarks, t }: Dependencies) {

  // Data import: pick a previously exported file (a Stash JSON backup, or a
  // Netscape HTML bookmarks file from any browser/bookmark app), parse it, and
  // re-ingest the bookmarks local-first. The mirror of export — "you can bring
  // your data in as easily as you can take it out."
  const [importSheetOpen, setImportSheetOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const runImport = async (kind: "json" | "html" | "csv") => {
    setImportSheetOpen(false);
    if (importing) {
      return;
    }
    setImporting(true);
    try {
      const picked = await pickImportFile(kind);
      if (!picked) {
        return; // user cancelled the picker
      }
      const items = parseImport(kind, picked.text);
      const summary = importBookmarks(items);

      if (summary.notReady) {
        Alert.alert(
          t("settings.import.notReadyTitle"),
          t("settings.import.notReadyBody"),
        );
        return;
      }
      if (
        summary.imported === 0 &&
        summary.duplicates === 0 &&
        summary.skipped === 0
      ) {
        Alert.alert(
          t("settings.import.nothingTitle"),
          t("settings.import.nothingBody", { name: picked.name }),
        );
        return;
      }
      const parts = [t("settings.import.added", { count: summary.imported })];
      if (summary.duplicates > 0) {
        parts.push(
          t("settings.import.duplicates", { count: summary.duplicates }),
        );
      }
      if (summary.skipped > 0) {
        parts.push(t("settings.import.skipped", { count: summary.skipped }));
      }
      Alert.alert(t("settings.import.completeTitle"), parts.join("\n"));
    } catch (error) {
      Alert.alert(
        t("settings.import.failedTitle"),
        error instanceof Error
          ? error.message
          : t("settings.import.failedBody"),
      );
    } finally {
      setImporting(false);
    }
  };
  return { importSheetOpen, setImportSheetOpen, importing, runImport };
}
