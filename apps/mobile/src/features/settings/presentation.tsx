import { makeStyles, type IoniconName } from '@/features/settings/layout';
import { usePalette } from '@/theme';
import { Card } from "@/ui/Card";
import { Ionicons } from "@expo/vector-icons";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from "react-native";

/** Rounded card that groups settings rows with hairline dividers, under an
 *  optional uppercase section header so the screen reads as labelled sections
 *  (iOS-Settings style) rather than a stack of anonymous cards. */
export function Group({
  children,
  styles,
  title,
  footnote,
}: {
  children: React.ReactNode;
  styles: ReturnType<typeof makeStyles>;
  title?: string;
  /** Caption rendered beneath the card (iOS-style section footer). */
  footnote?: string;
}) {
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionLabel}>{title}</Text> : null}
      <Card style={styles.group} elevated={false}>
        {children}
      </Card>
      {footnote ? <Text style={styles.footnote}>{footnote}</Text> : null}
    </View>
  );
}

/** A tappable (or static) settings row: icon · label/value · trailing element. */
export function Row({
  styles,
  palette,
  icon,
  label,
  value,
  onPress,
  right,
  badge,
  accent,
  last,
  disabled,
  accessibilityLabel,
  expanded,
  testID,
}: {
  styles: ReturnType<typeof makeStyles>;
  palette: ReturnType<typeof usePalette>;
  icon: IoniconName;
  label: string;
  value?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  badge?: number;
  accent?: boolean;
  last?: boolean;
  /** A non-pressable row that represents a DISABLED control (vs static info):
   *  dims the row and announces a disabled button to assistive tech. */
  disabled?: boolean;
  accessibilityLabel?: string;
  expanded?: boolean;
  testID?: string;
}) {
  const rowStyle: StyleProp<ViewStyle> = [styles.row, !last && styles.divider];
  const labelColor = accent ? palette.accent : palette.text;

  const content = (
    <>
      <View
        style={[
          styles.iconWrap,
          accent && { backgroundColor: palette.accentSoft },
        ]}
      >
        <Ionicons
          name={icon}
          size={18}
          color={accent ? palette.accentText : palette.text}
        />
      </View>
      <View style={styles.rowText}>
        <Text
          style={[styles.rowLabel, { color: labelColor }]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {value ? (
          <Text style={styles.rowValue} numberOfLines={2}>
            {value}
          </Text>
        ) : null}
      </View>
      {badge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      {right ??
        (onPress ? (
          <Ionicons
            name="chevron-forward"
            size={18}
            color={palette.textSecondary}
          />
        ) : null)}
    </>
  );

  if (!onPress) {
    // A disabled control (e.g. "Clear search history" with no history): dim it so
    // it reads as inert rather than tappable, and announce the disabled state to
    // screen readers (a plain info row stays role-less and full-strength).
    if (disabled) {
      return (
        <View
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={{ disabled: true }}
          style={[rowStyle, { opacity: 0.4 }]}
        >
          {content}
        </View>
      );
    }
    return (
      <View testID={testID} style={rowStyle}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { opacity: 0.6 }]}
    >
      {content}
    </Pressable>
  );
}

/** Compact label/value row used for read-only diagnostics. */
export function InfoRow({
  styles,
  label,
  value,
  last,
}: {
  styles: ReturnType<typeof makeStyles>;
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.infoRow, !last && styles.divider]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text selectable style={styles.infoValue}>
        {value}
      </Text>
    </View>
  );
}
