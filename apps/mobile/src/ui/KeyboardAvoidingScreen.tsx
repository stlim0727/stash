import { KeyboardAvoidingView, StyleSheet, type KeyboardAvoidingViewProps } from 'react-native';

/**
 * Wraps a screen's scrollable / flex content so a focused text input is lifted
 * clear of the software keyboard instead of being covered by it.
 *
 * Android is always edge-to-edge from Expo SDK 54+, which means the system no
 * longer resizes (or pans) the activity window when the keyboard opens — the
 * keyboard is reported as an inset over an unchanged window. A plain ScrollView
 * therefore can't scroll its focused field above the keyboard on its own (the
 * symptom: the tag field / notes box sitting under the keyboard on the bookmark
 * detail screen). KeyboardAvoidingView reads the keyboard frame from keyboard
 * events and pads the bottom on both platforms, shrinking the visible area so a
 * child ScrollView scrolls the focused input into view.
 *
 * `behavior="padding"` is used on both platforms: under edge-to-edge the window
 * isn't resized, so there's no native adjustment to double-count, and padding is
 * the most predictable behavior for ScrollView-wrapped content.
 */
export function KeyboardAvoidingScreen({
  style,
  behavior = 'padding',
  ...props
}: KeyboardAvoidingViewProps) {
  return <KeyboardAvoidingView style={[styles.flex, style]} behavior={behavior} {...props} />;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
