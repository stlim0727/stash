import {
  exportFilename,
  toCsv,
  toJsonBackup,
  toNetscapeHtml,
  type ExportInput,
} from "@/domain/export";
import type { AIEnrichment, Bookmark, Tag } from '@/domain/types';
import type { TFunction } from '@/i18n/translate';
import { deliverExport, saveExportToDevice } from "@/share/export-data";
import { useBookmarks } from '@/store/bookmarks';
import Constants from "expo-constants";
import type { Dispatch, SetStateAction } from 'react';
import {
  Alert,
  Platform
} from "react-native";

interface Dependencies {
  collections: ReturnType<typeof useBookmarks>["collections"];
  setExportSheetOpen: Dispatch<SetStateAction<boolean>>;
  setExportDeliveryKind: Dispatch<SetStateAction<"html" | "json" | "csv" | null>>;
  exporting: boolean;
  setExporting: Dispatch<SetStateAction<boolean>>;
  inbox: Bookmark[];
  getTagsForBookmark: (id: string) => Tag[];
  getEnrichment: (bookmarkId: string) => AIEnrichment | undefined;
  t: TFunction;
}

export function useExportActions({
  collections,
  setExportSheetOpen,
  setExportDeliveryKind,
  exporting,
  setExporting,
  inbox,
  getTagsForBookmark,
  getEnrichment,
  t,
}: Dependencies) {

  const chooseExport = (kind: "html" | "json" | "csv") => {
    if (Platform.OS === "android") {
      setExportSheetOpen(false);
      setExportDeliveryKind(kind);
      return;
    }
    void runExport(kind, "share");
  };

  const runExport = async (
    kind: "html" | "json" | "csv",
    delivery: "share" | "save",
  ) => {
    setExportSheetOpen(false);
    setExportDeliveryKind(null);
    if (exporting) {
      return;
    }
    setExporting(true);
    try {
      const bookmarks = [...inbox];
      const tagsByBookmark: ExportInput["tagsByBookmark"] = {};
      const enrichmentByBookmark: NonNullable<
        ExportInput["enrichmentByBookmark"]
      > = {};
      for (const bookmark of bookmarks) {
        tagsByBookmark[bookmark.id] = getTagsForBookmark(bookmark.id);
        enrichmentByBookmark[bookmark.id] = getEnrichment(bookmark.id);
      }
      const input: ExportInput = {
        bookmarks,
        tagsByBookmark,
        enrichmentByBookmark,
        collections,
        exportedAt: new Date().toISOString(),
        appVersion: Constants.expoConfig?.version ?? undefined,
      };

      const file =
        kind === "html"
          ? {
            filename: exportFilename("html", input.exportedAt),
            mimeType: "text/html",
            contents: toNetscapeHtml(input),
          }
          : kind === "csv"
            ? {
              filename: exportFilename("csv", input.exportedAt),
              mimeType: "text/csv",
              contents: toCsv(input),
            }
            : {
              filename: exportFilename("json", input.exportedAt),
              mimeType: "application/json",
              contents: toJsonBackup(input),
            };
      if (delivery === "save") {
        const saved = await saveExportToDevice(file);
        if (saved) {
          Alert.alert(
            t("settings.export.savedTitle"),
            t("settings.export.savedBody", { name: file.filename }),
          );
        }
      } else {
        await deliverExport(file);
      }
    } catch (error) {
      Alert.alert(
        t("settings.export.failedTitle"),
        error instanceof Error
          ? error.message
          : t("settings.export.failedBody"),
      );
    } finally {
      setExporting(false);
    }
  };
  return { chooseExport, runExport };
}
