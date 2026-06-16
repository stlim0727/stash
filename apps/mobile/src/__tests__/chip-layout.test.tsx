/**
 * Layout regression guards for the Chip component.
 *
 * These do not render on a real device, so they cannot prove the absence of
 * clipping. What they DO guarantee is that the specific style invariants we
 * added to fix the Browse-chip clipping (PR #62) can never silently regress:
 * without an explicit lineHeight, Android under-measures bold text and clips
 * the glyph descenders inside the pill.
 */
import { render } from '@testing-library/react-native';
import { StyleSheet, type TextStyle } from 'react-native';

import { Chip } from '@/ui/Chip';

function labelStyle(node: { props: { style?: unknown } }): TextStyle {
  return StyleSheet.flatten(node.props.style) as TextStyle;
}

test('chip label declares an explicit lineHeight (Android descender clip guard)', async () => {
  const { getByText } = await render(<Chip>All</Chip>);
  const style = labelStyle(getByText('All'));

  expect(typeof style.lineHeight).toBe('number');
});

test('chip label lineHeight leaves room for descenders (>= fontSize)', async () => {
  const { getByText } = await render(<Chip>No collection</Chip>);
  const style = labelStyle(getByText('No collection'));

  // A lineHeight smaller than the font size guarantees clipping; require at
  // least the font size so ascenders/descenders fit.
  expect(style.lineHeight).toBeGreaterThanOrEqual(style.fontSize as number);
});
