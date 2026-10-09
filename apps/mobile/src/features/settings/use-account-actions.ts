import type { TFunction } from '@/i18n/translate';
import { useSupabaseAuth } from "@/supabase/auth-provider";
import type { OAuthProvider } from "@/supabase/types";
import { useState } from "react";
import {
  Alert,
  Platform
} from "react-native";

interface Dependencies {
  auth: ReturnType<typeof useSupabaseAuth>;
  t: TFunction;
}

export function useAccountActions({ auth, t }: Dependencies) {

  // Sign in / out happens inline in the account card (no separate screen).
  // `authBusy` disables the auth buttons while a provider flow or sign-out runs.
  const [authBusy, setAuthBusy] = useState<OAuthProvider | "signout" | null>(
    null,
  );
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const handleSignIn = async (provider: OAuthProvider) => {
    setAuthBusy(provider);
    try {
      await auth.signIn(provider);
    } catch (error) {
      Alert.alert(
        t("account.signInFailedTitle"),
        error instanceof Error ? error.message : t("account.signInFailedBody"),
      );
    } finally {
      setAuthBusy(null);
    }
  };
  // Sign-out is confirmed first: logging out hides the whole library from view,
  // so we reassure that the data is safe in the account before proceeding. Only
  // the destructive confirm actually calls `auth.signOut()`.
  const runSignOut = async () => {
    setAuthBusy("signout");
    try {
      await auth.signOut();
    } finally {
      setAuthBusy(null);
    }
  };
  const handleSignOut = () => {
    if (Platform.OS === "web") {
      // Alert.alert has no button support on web, so the confirm dialog never
      // appears and sign-out never fires ("logout does not work"). Fall back to
      // window.confirm like the other destructive confirms on this screen.
      if (
        typeof confirm === "undefined" ||
        confirm(t("settings.account.signOutConfirmBody"))
      ) {
        void runSignOut();
      }
      return;
    }
    Alert.alert(
      t("settings.account.signOutConfirmTitle"),
      t("settings.account.signOutConfirmBody"),
      [
        { text: t("settings.account.signOutCancel"), style: "cancel" },
        {
          text: t("settings.account.signOutConfirm"),
          style: "destructive",
          onPress: () => void runSignOut(),
        },
      ],
    );
  };
  return { authBusy, tutorialOpen, setTutorialOpen, handleSignIn, handleSignOut };
}
