import {
  AI_SUGGESTIONS_MODES,
  type AiSuggestionsMode,
} from "@/domain/ai-suggestions-pref";
import { SUPPORTED_LOCALES, useI18n, type LocalePreference } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import type { OAuthProvider } from "@/supabase/types";
import { usePalette } from "@/theme";
import { Ionicons } from "@expo/vector-icons";
import {
  Alert,
  Platform,
  StyleSheet,
  type StyleProp,
  type ViewStyle
} from "react-native";

export const DEVELOPER_MODE_PREF_KEY = "settings.developer-mode";

// Web only: Settings is a `transparentModal`, so the Inbox stays mounted behind
// it. On mobile browsers, dragging the scroll past its end rubber-bands the
// whole page (the scroll chains up to the transparent html/body — see
// pwa-head.web.ts), sliding this opaque modal and exposing the Inbox cards
// underneath. Containing overscroll stops the chain so nothing bleeds through.
// `overscrollBehavior` is a web CSS property react-native-web forwards but RN's
// ViewStyle type doesn't model, hence the cast; it's inert on native.
export const webOverscrollContain: StyleProp<ViewStyle> =
  Platform.OS === "web"
    ? ({ overscrollBehavior: "contain" } as ViewStyle)
    : undefined;

export function showAlert(title: string, message?: string) {
  if (Platform.OS === "web" && typeof alert !== "undefined") {
    alert(message ? `${title}\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}

export type AppPalette = ReturnType<typeof usePalette>;

/** Sign-in providers, in display order (Google first), with logo + a11y keys. */
export const AUTH_PROVIDERS: {
  id: OAuthProvider;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  a11yKey: MessageKey;
}[] = [
    {
      id: "google",
      label: "Google",
      icon: "logo-google",
      a11yKey: "account.signInGoogle",
    },
    {
      id: "apple",
      label: "Apple",
      icon: "logo-apple",
      a11yKey: "account.signInApple",
    },
  ];

/** The language-preference options, in display order, with their label keys. */
export const LANGUAGE_OPTIONS: { value: LocalePreference; labelKey: MessageKey }[] = [
  { value: "system", labelKey: "settings.language.system" },
  ...SUPPORTED_LOCALES.map((code) => ({
    value: code,
    labelKey: `settings.language.${code}` as MessageKey,
  })),
];

/** The AI-suggestions mode options, in display order (least → most automatic),
 *  with their label keys. */
export const AI_SUGGESTIONS_MODE_OPTIONS: {
  value: AiSuggestionsMode;
  labelKey: MessageKey;
}[] = AI_SUGGESTIONS_MODES.map((mode) => ({
  value: mode,
  labelKey: `settings.aiSuggestions.${mode}` as MessageKey,
}));

/** "5:41 PM" for a reset later today, "Aug 3, 5:41 PM" otherwise — a bare
 *  time for a reset on a different day would misread as already past once
 *  it's tomorrow's clock time (restored from PR #664 for the Activity chip's
 *  quota-reached text, dropped by the #698 chip-strip pass). */
export function formatQuotaResetTime(
  retryAt: number,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
): string {
  const isToday = new Date(retryAt).toDateString() === new Date().toDateString();
  return formatDate(
    retryAt,
    isToday
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  );
}

export type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

export const makeStyles = (palette: AppPalette) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
      backgroundColor: palette.background,
    },
    fullScreen: {
      flex: 1,
      backgroundColor: palette.background,
    },
    sheetOverlay: {
      flex: 1,
      flexDirection: "row",
    },
    sheetBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
    },
    sheetPanel: {
      width: "100%",
      maxWidth: 460,
      backgroundColor: palette.background,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
      backgroundColor: palette.background,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: palette.text,
    },
    headerClose: {
      padding: 4,
    },
    container: {
      padding: 16,
      gap: 18,
    },
    account: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    accountFocused: {
      borderColor: palette.accent,
      borderWidth: 2,
      backgroundColor: palette.accentSoft,
    },
    accountFocusedHeader: {
      flexDirection: "column",
      alignItems: "stretch",
      gap: 16,
    },
    accountFocusedButtons: {
      flexDirection: "column",
      alignItems: "stretch",
    },
    accountFocusedText: {
      gap: 2,
    },
    accountGuide: {
      fontSize: 14,
      lineHeight: 20,
      color: palette.accentText,
      marginTop: 6,
    },
    // No bottom border: the Account card now holds identity only (the sync
    // row that used to follow it moved to the Activity section), so there's
    // nothing left to divide it from.
    accountHeaderOnly: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 16,
    },
    authButtons: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    accountText: {
      flex: 1,
      gap: 2,
    },
    accountName: {
      fontSize: 17,
      fontWeight: "700",
      color: palette.text,
    },
    accountMeta: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    section: {
      gap: 8,
    },
    group: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    bookmarkletRow: {
      padding: 16,
      alignItems: "flex-start",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    iconWrap: {
      width: 32,
      height: 32,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.mutedSurface,
    },
    rowText: {
      flex: 1,
      gap: 2,
    },
    rowLabel: {
      fontSize: 15,
      fontWeight: "600",
    },
    rowValue: {
      fontSize: 13,
      color: palette.textSecondary,
    },
    syncActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    syncIconButton: {
      padding: 4,
    },
    divider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    badge: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.accent,
    },
    badgeText: {
      color: "#ffffff",
      fontSize: 12,
      fontWeight: "700",
    },
    infoRow: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 3,
    },
    infoLabel: {
      fontSize: 14,
      fontWeight: "600",
      color: palette.text,
    },
    infoValue: {
      fontSize: 15,
      lineHeight: 22,
      color: palette.text,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: "600",
      color: palette.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginLeft: 4,
    },
    buildLine: {
      alignItems: "center",
      paddingTop: 4,
      paddingBottom: 2,
    },
    buildLineText: {
      fontSize: 11,
      color: palette.textSecondary,
      opacity: 0.7,
    },
    footnote: {
      fontSize: 13,
      color: palette.textSecondary,
      marginHorizontal: 4,
      lineHeight: 18,
    },
  });
