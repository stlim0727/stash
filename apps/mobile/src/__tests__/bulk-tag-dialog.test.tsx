import { act, fireEvent, render } from '@testing-library/react-native';
import { BulkTagDialog } from '@/ui/BulkTagDialog';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

describe('BulkTagDialog', () => {
  const onApplyTag = jest.fn();
  const onClose = jest.fn();

  beforeEach(() => {
    onApplyTag.mockClear();
    onClose.mockClear();
  });

  test('does not render content when not visible', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={false}
        selectedCount={3}
        existingTags={[]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );
    expect(screen.queryByTestId('bulk-tag-dialog')).toBeNull();
  });

  test('renders dialog with count and placeholder when visible', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={3}
        existingTags={[]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('bulk-tag-dialog')).toBeTruthy();
    expect(screen.getByText('Add tag to 3 bookmarks')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter tag name')).toBeTruthy();
  });

  test('displays existing tag chips and tapping one calls onApplyTag', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={2}
        existingTags={[
          { id: '1', name: 'reading', count: 5 },
          { id: '2', name: 'work', count: 3 },
        ]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );
    expect(screen.getByText('#reading')).toBeTruthy();
    expect(screen.getByText('#work')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('bulk-tag-chip-reading'));
    });
    expect(onApplyTag).toHaveBeenCalledWith('reading');
  });

  test('filters existing tags when typing into input', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={2}
        existingTags={[
          { id: '1', name: 'reading', count: 5 },
          { id: '2', name: 'recipes', count: 3 },
          { id: '3', name: 'work', count: 2 },
        ]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId('bulk-tag-input');
    await act(async () => {
      fireEvent.changeText(input, 'rec');
    });

    expect(screen.getByText('#recipes')).toBeTruthy();
    expect(screen.queryByText('#work')).toBeNull();
  });

  test('submitting typed tag via Add button calls onApplyTag without leading hash', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={1}
        existingTags={[]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId('bulk-tag-input');
    await act(async () => {
      fireEvent.changeText(input, '#investing');
    });

    await act(async () => {
      fireEvent.press(screen.getByTestId('bulk-tag-submit'));
    });

    expect(onApplyTag).toHaveBeenCalledWith('investing');
  });

  test('submitting typed tag via returnKey on keyboard calls onApplyTag', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={4}
        existingTags={[]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId('bulk-tag-input');
    await act(async () => {
      fireEvent.changeText(input, 'tech');
    });

    await act(async () => {
      fireEvent(input, 'submitEditing');
    });

    expect(onApplyTag).toHaveBeenCalledWith('tech');
  });

  test('cancel button calls onClose', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={2}
        existingTags={[]}
        busy={false}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('bulk-tag-cancel'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  test('displays error message when provided', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={2}
        existingTags={[]}
        busy={false}
        error="This bookmark cannot be tagged."
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );
    expect(screen.getByText('This bookmark cannot be tagged.')).toBeTruthy();
  });

  test('disables submit button when input is empty or busy', async () => {
    const screen = await render(
      <BulkTagDialog
        visible={true}
        selectedCount={2}
        existingTags={[]}
        busy={true}
        error={null}
        onApplyTag={onApplyTag}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('bulk-tag-submit').props.accessibilityState?.disabled).toBe(true);
  });
});
