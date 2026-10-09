import type { TFunction } from '@/i18n/translate';
import type { ResetLibraryResult } from '@/store/bookmarks';
import { useState } from "react";
import {
  Alert
} from "react-native";

interface Dependencies {
  isResettingLibrary: boolean;
  resetLibrary: () => Promise<ResetLibraryResult>;
  t: TFunction;
}

export function useResetActions({ isResettingLibrary, resetLibrary, t }: Dependencies) {

  // Library reset (issue #600): a destructive, online-only, type-to-confirm
  // flow. The store owns ordering (remote wipe first, local clear only after
  // it succeeds); this screen owns the confirmation gate and result surfacing.
  // While it runs, export/import/sync controls are disabled (see the rows and
  // canSync below).
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const runReset = async () => {
    if (isResettingLibrary) {
      return;
    }
    setResetError(null);
    const result = await resetLibrary();
    if (result.ok) {
      setResetDialogOpen(false);
      Alert.alert(
        t("settings.reset.successTitle"),
        t("settings.reset.successBody"),
      );
      return;
    }
    const bodyKey = (
      {
        busy: "settings.reset.failedBusy",
        auth: "settings.reset.failedAuth",
        remote: "settings.reset.failedRemote",
        local: "settings.reset.failedLocal",
      } as const
    )[result.reason];
    // Keep the dialog open with the failure inline so retry keeps its context.
    setResetError(
      result.message ? `${t(bodyKey)}\n${result.message}` : t(bodyKey),
    );
  };
  return { resetDialogOpen, setResetDialogOpen, resetError, setResetError, runReset };
}
