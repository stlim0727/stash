import { useMemo, type ComponentProps } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
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
 */
export function HighlightedText({ text, query, highlightStyle, ...textProps }: HighlightedTextProps) {
  const segments = useMemo(() => highlightSegments(text, query), [text, query]);
  // Fast path: nothing matched (or no query) → a single plain run, no nesting.
  if (segments.length === 1 && !segments[0]!.match) {
    return (
      <PostHogMaskView>
        <Text {...textProps}>{text}</Text>
      </PostHogMaskView>
    );
  }
  return (
    <PostHogMaskView>
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
