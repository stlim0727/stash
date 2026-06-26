import { render } from '@testing-library/react-native';

import { HighlightedText } from '@/ui/HighlightedText';

const HL = { backgroundColor: 'yellow', color: 'black' };

test('wraps the matched span in the highlight style', async () => {
  const screen = await render(
    <HighlightedText text="Design System" query="design" highlightStyle={HL} />,
  );
  const match = screen.getByText('Design');
  expect(match.props.style).toEqual(HL);
  // The full label is still present/readable.
  expect(screen.getByText(/Design System/)).toBeTruthy();
});

test('renders a plain label (no highlighted run) when nothing matches', async () => {
  const screen = await render(
    <HighlightedText text="Design System" query="recipes" highlightStyle={HL} />,
  );
  expect(screen.getByText('Design System')).toBeTruthy();
  expect(screen.queryByText('Design')).toBeNull();
});

test('renders a plain label when there is no query', async () => {
  const screen = await render(
    <HighlightedText text="Design System" query="" highlightStyle={HL} />,
  );
  expect(screen.getByText('Design System')).toBeTruthy();
  expect(screen.queryByText('Design')).toBeNull();
});
