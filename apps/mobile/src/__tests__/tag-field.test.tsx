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

test('"Add all" accepts every suggestion at once (shown only for 2+)', async () => {
  const onAcceptAllSuggestions = jest.fn();
  // One suggestion: the bulk action stays hidden.
  const single = await setup({ onAcceptAllSuggestions });
  expect(single.screen.queryByLabelText('Add all suggestions')).toBeNull();

  // Two suggestions: the bulk action appears and fires the handler.
  const multi = await setup({
    onAcceptAllSuggestions,
    suggestions: [
      { name: 'dinner', confidence: 0.8 },
      { name: 'korean', confidence: 0.7 },
    ],
  });
  await fireEvent.press(multi.screen.getByLabelText('Add all suggestions'));
  expect(onAcceptAllSuggestions).toHaveBeenCalledTimes(1);
});

test('a folder suggestion leads the row and is swept by the bulk threshold', async () => {
  const onAccept = jest.fn();
  const onAcceptAllSuggestions = jest.fn();
  const folderSuggestion = {
    label: 'File into Recipes',
    acceptA11y: 'File this into Recipes',
    dismissA11y: 'Dismiss suggested folder Recipes',
    onAccept,
    onDismiss: noop,
  };

  // A folder plus a single tag is two actionable suggestions, so the bulk row
  // appears even though there's only one tag chip.
  const { screen } = await setup({ folderSuggestion, onAcceptAllSuggestions });
  expect(screen.getByLabelText('File this into Recipes')).toBeTruthy();
  expect(screen.getByLabelText('Add all suggestions')).toBeTruthy();

  await fireEvent.press(screen.getByLabelText('File this into Recipes'));
  expect(onAccept).toHaveBeenCalledTimes(1);
});

test('a folder suggestion alone shows its chip but no bulk actions', async () => {
  const onAcceptAllSuggestions = jest.fn();
  const folderSuggestion = {
    label: 'File into Recipes',
    acceptA11y: 'File this into Recipes',
    dismissA11y: 'Dismiss suggested folder Recipes',
    onAccept: noop,
    onDismiss: noop,
  };

  // No tag suggestions: the lone folder chip is one action, so "Add all" stays
  // hidden — the chip itself is the single tap.
  const { screen } = await setup({ folderSuggestion, suggestions: [], onAcceptAllSuggestions });
  expect(screen.getByLabelText('File this into Recipes')).toBeTruthy();
  expect(screen.queryByLabelText('Add all suggestions')).toBeNull();
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
