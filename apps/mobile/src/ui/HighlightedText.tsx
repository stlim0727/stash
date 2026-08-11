import { useMemo, type ComponentProps } from 'react';
import { Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { PostHogMaskView } from 'posthog-react-native';

import { highlightSegments } from '@/domain/highlight';

type TextProps = ComponentProps<typeof Text>;

interface HighlightedTextProps extends TextProps {
  /** The full string to render. */
  text: string;
  /** Active search query; matched spans get `highlightStyle`. Empty = no highlight. */
  query: string;
  /** Style applied to the matched runs (e.g. accent background + color). */
  highlightStyle: StyleProp<TextStyle>;
}

/**
 * Renders `text` with the spans matching `query` visually emphasized. Delegates
 * the match math to the pure `highlightSegments`, so the same tolerant-but-
 * literal highlighting is testable without a renderer. All other Text props
 * (style, numberOfLines, testID, …) pass straight through to the outer Text, so
 * this is a drop-in replacement for a plain `<Text>` label.
 *
 * Every current use of this component renders bookmark-derived content
 * (title, site label, URL), so the output is unconditionally wrapped in
 * `PostHogMaskView` to hide it from PostHog session replay recordings.
 * Callers use this in several different flex layouts (a fixed-width list row,
 * a `flex: 1` card title, a `flexShrink: 1` card URL) — the wrapper View has
 * no layout behavior of its own unless it carries the same layout-relevant
 * style the Text would have had as a direct row child, so `textProps.style`
 * is forwarded to it too (font/color properties in that style are simply
 * ignored by the View; only the flex/sizing ones matter here).
 */
export function HighlightedText({ text, query, highlightStyle, ...textProps }: HighlightedTextProps) {
  const segments = useMemo(() => highlightSegments(text, query), [text, query]);
  const wrapperStyle = textProps.style as StyleProp<ViewStyle>;
  // Fast path: nothing matched (or no query) → a single plain run, no nesting.
  if (segments.length === 1 && !segments[0]!.match) {
    return (
      <PostHogMaskView style={wrapperStyle}>
        <Text {...textProps}>{text}</Text>
      </PostHogMaskView>
    );
  }
  return (
    <PostHogMaskView style={wrapperStyle}>
      <Text {...textProps}>
        {segments.map((segment, index) =>
          segment.match ? (
            <Text key={index} style={highlightStyle}>
              {segment.text}
            </Text>
          ) : (
            segment.text
          ),
        )}
      </Text>
    </PostHogMaskView>
  );
}
