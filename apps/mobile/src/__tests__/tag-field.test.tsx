import { fireEvent, render } from '@testing-library/react-native';

import { TagField } from '@/ui/TagField';

const noop = () => {};

async function setup(overrides: Partial<Parameters<typeof TagField>[0]> = {}) {
  const onAdd = jest.fn();
  const onRemove = jest.fn();
  const onAcceptSuggestion = jest.fn();
  const props = {
    tags: [{ id: 't1', name: 'food' }],
    suggestions: [{ name: 'dinner', confidence: 0.8 }],
    editable: true,
    busy: false,
    onAdd,
    onRemove,
    onBrowse: noop,
    onAcceptSuggestion,
    onDismissSuggestion: noop,
    ...overrides,
  };
  return { ...props, screen: await render(<TagField {...props} />) };
}

test('typing a tag then a space commits it (no Add button needed)', async () => {
  const { screen, onAdd } = await setup();
  await fireEvent.changeText(screen.getByLabelText('Add a tag'), 'korean ');
  expect(onAdd).toHaveBeenCalledWith('korean');
});

test('duplicate tags are ignored (case-insensitive)', async () => {
  const { screen, onAdd } = await setup();
  await fireEvent.changeText(screen.getByLabelText('Add a tag'), 'Food ');
  expect(onAdd).not.toHaveBeenCalled();
});

test('keeps the typed text when the add fails so it can be retried', async () => {
  const onAdd = jest.fn(async () => false);
  const { screen } = await setup({ onAdd });
  const input = screen.getByLabelText('Add a tag');

  await fireEvent.changeText(input, 'korean ');

  expect(onAdd).toHaveBeenCalledWith('korean');
  // The text is restored instead of being lost.
  expect(input.props.value).toBe('korean');
});

test('a suggestion chip accepts via its accessible label', async () => {
  const { screen, onAcceptSuggestion } = await setup();
  await fireEvent.press(screen.getByLabelText('Accept suggested tag dinner'));
  expect(onAcceptSuggestion).toHaveBeenCalledWith('dinner');
});

test('read-only mode hides the input and shows the hint', async () => {
  const { screen } = await setup({
    editable: false,
    tags: [],
    disabledHint: 'Synced bookmarks only.',
  });
  expect(screen.queryByLabelText('Add a tag')).toBeNull();
  expect(screen.getByText('Synced bookmarks only.')).toBeTruthy();
});
