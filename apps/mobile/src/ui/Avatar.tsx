import { useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { accountInitials } from '@/domain/account';
import { usePalette } from '@/theme';

interface AvatarProps {
  /** Diameter in points. */
  size?: number;
  /** Remote avatar image, if the OAuth provider shared one. */
  uri?: string | null;
  /** Email used to derive initials when there is no image. */
  email?: string | null;
  /** True for a permanent (non-anonymous) account. */
  authed?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Account avatar with a graceful fallback chain: provider image → initials for
 * a signed-in account → a neutral person glyph for anonymous / signed-out. The
 * remote image silently falls back to initials if it fails to load.
 */
export function Avatar({ size = 44, uri, email, authed = false, style }: AvatarProps) {
  const palette = usePalette();
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(uri) && !imageFailed;
  const radius = size / 2;

  if (showImage) {
    return (
      <Image
        source={{ uri: uri! }}
        onError={() => setImageFailed(true)}
        accessibilityIgnoresInvertColors
        style={[
          { width: size, height: size, borderRadius: radius, borderColor: palette.border },
          styles.image,
          style as StyleProp<ImageStyle>,
        ]}
      />
    );
  }

  return (
    <View
      style={[
        styles.fallback,
        { width: size, height: size, borderRadius: radius },
        authed
          ? { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft }
          : { backgroundColor: palette.surface, borderColor: palette.border },
        style,
      ]}
    >
      {authed ? (
        <Text style={[styles.initials, { color: palette.accentText, fontSize: size * 0.36 }]}>
          {accountInitials(email)}
        </Text>
      ) : (
        <Ionicons name="person" size={size * 0.5} color={palette.textSecondary} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  fallback: {
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontWeight: '800',
  },
});
