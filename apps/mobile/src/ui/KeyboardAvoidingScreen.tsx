import { useEffect, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Platform,
  StyleSheet,
  View,
  type KeyboardEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface KeyboardAvoidingScreenProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Wraps a screen's scrollable / flex content so a focused text input is lifted
 * clear of the software keyboard instead of being covered by it.
 *
 * Android is always edge-to-edge from Expo SDK 54+, which means the system no
 * longer resizes (or pans) the activity window when the keyboard opens — the
 * keyboard is reported as an inset over an unchanged window. A plain ScrollView
 * therefore can't scroll its focused field above the keyboard on its own (the
 * symptom: the tag field / notes box sitting under the keyboard on the bookmark
 * detail screen).
 *
 * We pad the bottom by the keyboard's height, which shrinks the child
 * ScrollView so it scrolls the focused input into the remaining space — the
 * same mechanism as `KeyboardAvoidingView` with `behavior="padding"`. We track
 * the height ourselves rather than use `KeyboardAvoidingView` because, on the
 * routed (Stack header) screens this wraps, that component under-pads by the
 * header height: it derives the overlap from its own parent-relative layout
 * (`frame.y` ≈ 0 below the header) while the keyboard frame is in screen
 * coordinates, so low fields stay partly covered. The keyboard height is a
 * screen-space magnitude measured from the bottom edge, so padding by it is
 * correct regardless of the header above.
 */
export function KeyboardAvoidingScreen({ children, style }: KeyboardAvoidingScreenProps) {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    // iOS fires Will* before the animation (smoother); Android only reliably
    // fires Did*. Either way endCoordinates.height is the keyboard's height
    // from the bottom of the screen.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (event: KeyboardEvent) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    };
    const onHide = () => setKeyboardHeight(0);
    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return <View style={[styles.flex, { paddingBottom: keyboardHeight }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
