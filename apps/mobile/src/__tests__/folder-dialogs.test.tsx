import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import type { Collection } from '@/domain/types';
import { DeleteCollectionDialog } from '@/ui/DeleteCollectionDialog';
import { FolderBulkActionBar } from '@/ui/FolderBulkActionBar';
import { MergeCollectionsDialog } from '@/ui/MergeCollectionsDialog';
import { RenameCollectionDialog } from '@/ui/RenameCollectionDialog';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

describe('FolderBulkActionBar', () => {
  it('renders correctly with 0 items (delete and merge disabled)', async () => {
    const onMerge = jest.fn();
    const onDelete = jest.fn();
    const screen = await render(
      <FolderBulkActionBar
        selectedCount={0}
        onMerge={onMerge}
        onDelete={onDelete}
      />,
    );

    expect(screen.getByTestId('folder-bulk-action-bar')).toBeTruthy();
    expect(screen.queryByTestId('folder-bulk-rename')).toBeNull();

    const deleteBtn = screen.getByTestId('folder-bulk-delete');
    await act(async () => {
      fireEvent.press(deleteBtn);
    });
    expect(onDelete).not.toHaveBeenCalled();

    const mergeBtn = screen.getByTestId('folder-bulk-merge');
    await act(async () => {
      fireEvent.press(mergeBtn);
    });
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('renders rename button when exactly 1 item is selected', async () => {
    const onRename = jest.fn();
    const onMerge = jest.fn();
    const onDelete = jest.fn();
    const screen = await render(
      <FolderBulkActionBar
        selectedCount={1}
        onRename={onRename}
        onMerge={onMerge}
        onDelete={onDelete}
      />,
    );

    const renameBtn = screen.getByTestId('folder-bulk-rename');
    await act(async () => {
      fireEvent.press(renameBtn);
    });
    expect(onRename).toHaveBeenCalledTimes(1);

    const deleteBtn = screen.getByTestId('folder-bulk-delete');
    await act(async () => {
      fireEvent.press(deleteBtn);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('enables merge when 2 or more items are selected', async () => {
    const onMerge = jest.fn();
    const onDelete = jest.fn();
    const screen = await render(
      <FolderBulkActionBar
        selectedCount={3}
        onMerge={onMerge}
        onDelete={onDelete}
      />,
    );

    expect(screen.queryByTestId('folder-bulk-rename')).toBeNull();

    const mergeBtn = screen.getByTestId('folder-bulk-merge');
    await act(async () => {
      fireEvent.press(mergeBtn);
    });
    expect(onMerge).toHaveBeenCalledTimes(1);

    const deleteBtn = screen.getByTestId('folder-bulk-delete');
    await act(async () => {
      fireEvent.press(deleteBtn);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('RenameCollectionDialog', () => {
  it('submits trimmed new name and handles cancel', async () => {
    const onRename = jest.fn();
    const onClose = jest.fn();
    const screen = await render(
      <RenameCollectionDialog
        visible={true}
        busy={false}
        error={null}
        initialName="Old Name"
        onRename={onRename}
        onClose={onClose}
      />,
    );

    const input = screen.getByTestId('rename-collection-input');
    expect(input.props.value).toBe('Old Name');

    await act(async () => {
      fireEvent.changeText(input, '  Updated Name  ');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('rename-collection-submit'));
    });
    expect(onRename).toHaveBeenCalledWith('Updated Name');

    await act(async () => {
      fireEvent.press(screen.getByTestId('rename-collection-cancel'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('disables submit on empty input', async () => {
    const onRename = jest.fn();
    const screen = await render(
      <RenameCollectionDialog
        visible={true}
        busy={false}
        error={null}
        initialName="Old Name"
        onRename={onRename}
        onClose={jest.fn()}
      />,
    );

    const input = screen.getByTestId('rename-collection-input');
    await act(async () => {
      fireEvent.changeText(input, '   ');
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('rename-collection-submit'));
    });
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe('DeleteCollectionDialog', () => {
  it('calls onDeleteKeep and onDeleteTrash', async () => {
    const onDeleteKeep = jest.fn();
    const onDeleteTrash = jest.fn();
    const onClose = jest.fn();

    const screen = await render(
      <DeleteCollectionDialog
        visible={true}
        busy={false}
        collectionCount={1}
        collectionName="Reading"
        bookmarkCount={5}
        onDeleteKeep={onDeleteKeep}
        onDeleteTrash={onDeleteTrash}
        onClose={onClose}
      />,
    );

    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-collection-keep-button'));
    });
    expect(onDeleteKeep).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-collection-trash-button'));
    });
    expect(onDeleteTrash).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByTestId('delete-collection-cancel'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MergeCollectionsDialog', () => {
  const dummyCollections: Collection[] = [
    {
      id: 'col-1',
      user_id: 'user-1',
      name: 'Design',
      description: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: 'col-2',
      user_id: 'user-1',
      name: 'Engineering',
      description: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  it('starts with no target selected and disabled submit button, enabling on selection', async () => {
    const onMerge = jest.fn();
    const onClose = jest.fn();

    const screen = await render(
      <MergeCollectionsDialog
        visible={true}
        busy={false}
        error={null}
        sourceCollections={[dummyCollections[0]]}
        availableTargets={dummyCollections}
        onMerge={onMerge}
        onClose={onClose}
      />,
    );

    // Submit button is disabled initially
    const submitBtn = screen.getByTestId('merge-collections-submit');
    expect(submitBtn.props.accessibilityState.disabled).toBe(true);

    // Pressing submit does nothing
    await act(async () => {
      fireEvent.press(submitBtn);
    });
    expect(onMerge).not.toHaveBeenCalled();

    // Select col-2
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-2'));
    });

    // Submit is now enabled
    expect(submitBtn.props.accessibilityState.disabled).toBe(false);

    await act(async () => {
      fireEvent.press(submitBtn);
    });
    expect(onMerge).toHaveBeenCalledWith('col-2');

    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-cancel'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows multi-source vessel cards, dignified notices, and contextual confirm label after selection', async () => {
    const onMerge = jest.fn();
    const onClose = jest.fn();
    const counts = new Map([
      ['col-1', 12],
      ['col-2', 8],
    ]);

    const screen = await render(
      <MergeCollectionsDialog
        visible={true}
        busy={false}
        error={null}
        sourceCollections={dummyCollections}
        availableTargets={dummyCollections}
        collectionCounts={counts}
        onMerge={onMerge}
        onClose={onClose}
      />,
    );

    // Prompt
    expect(screen.getByText('Which collection should hold everything?')).toBeTruthy();

    // Initially no target is selected: submit is disabled and no consequence notice yet
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(true);
    expect(screen.queryByTestId('merge-collections-notice')).toBeNull();

    // Both cards show 'Select' badge initially
    const selectBadges = screen.getAllByText('Select');
    expect(selectBadges.length).toBe(2);

    // Select Design (col-1)
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-1'));
    });

    // Target is now col-1 (Design)
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByTestId('merge-collections-notice')).toBeTruthy();
    expect(
      screen.getByText(
        '8 bookmarks from “Engineering” will move into “Design”, and empty collections will be retired.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('All 20 bookmarks are safely preserved.')).toBeTruthy();
    expect(screen.getByText('Keep “Design”')).toBeTruthy();

    // Badges update
    expect(screen.getByText('Keep')).toBeTruthy();
    expect(screen.getByText('Will be merged')).toBeTruthy();

    // Select Engineering (col-2)
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-2'));
    });

    expect(
      screen.getByText(
        '12 bookmarks from “Design” will move into “Engineering”, and empty collections will be retired.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('All 20 bookmarks are safely preserved.')).toBeTruthy();
    expect(screen.getByText('Keep “Engineering”')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-submit'));
    });

    expect(onMerge).toHaveBeenCalledWith('col-2');
  });

  it('maintains valid selection when available targets update', async () => {
    const onMerge = jest.fn();
    const onClose = jest.fn();

    const screen = await render(
      <MergeCollectionsDialog
        visible={true}
        busy={false}
        error={null}
        sourceCollections={dummyCollections}
        availableTargets={dummyCollections}
        onMerge={onMerge}
        onClose={onClose}
      />,
    );

    // Select col-1
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-1'));
    });
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(false);

    // Re-render with new array containing col-1 and col-2 plus col-3
    const col3: Collection = {
      id: 'col-3',
      user_id: 'user-1',
      name: 'Product',
      description: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await act(async () => {
      screen.rerender(
        <MergeCollectionsDialog
          visible={true}
          busy={false}
          error={null}
          sourceCollections={dummyCollections}
          availableTargets={[...dummyCollections, col3]}
          onMerge={onMerge}
          onClose={onClose}
        />,
      );
    });

    // Selection on col-1 remains maintained!
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(false);
    expect(screen.getByText('Keep “Design”')).toBeTruthy();
  });

  it('clears selection and displays notice when target disappears from available targets without auto-substituting', async () => {
    const onMerge = jest.fn();
    const onClose = jest.fn();

    const screen = await render(
      <MergeCollectionsDialog
        visible={true}
        busy={false}
        error={null}
        sourceCollections={dummyCollections}
        availableTargets={dummyCollections}
        onMerge={onMerge}
        onClose={onClose}
      />,
    );

    // Select col-1
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-1'));
    });
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(false);

    // Re-render with col-1 removed (only col-2 remains)
    await act(async () => {
      screen.rerender(
        <MergeCollectionsDialog
          visible={true}
          busy={false}
          error={null}
          sourceCollections={dummyCollections}
          availableTargets={[dummyCollections[1]]}
          onMerge={onMerge}
          onClose={onClose}
        />,
      );
    });

    // Selection must be cleared, NOT auto-substituted to col-2
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(true);
    // Target lost notice is displayed
    expect(screen.getByTestId('merge-target-lost-notice')).toBeTruthy();
    expect(
      screen.getByText('The selected collection is no longer available. Please select another collection.'),
    ).toBeTruthy();
  });

  it('prevents submission and user interactions while busy', async () => {
    const onMerge = jest.fn();
    const onClose = jest.fn();

    const screen = await render(
      <MergeCollectionsDialog
        visible={true}
        busy={true}
        error={null}
        sourceCollections={dummyCollections}
        availableTargets={dummyCollections}
        onMerge={onMerge}
        onClose={onClose}
      />,
    );

    // Submit button is disabled while busy
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(true);

    // Tapping target does nothing while busy
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-1'));
    });
    expect(screen.getByTestId('merge-collections-submit').props.accessibilityState.disabled).toBe(true);

    // Pressing submit does nothing
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-submit'));
    });
    expect(onMerge).not.toHaveBeenCalled();
  });

  it('displays error banner when error prop is provided', async () => {
    const screen = await render(
      <MergeCollectionsDialog
        visible={true}
        busy={false}
        error="Network error while merging"
        sourceCollections={dummyCollections}
        availableTargets={dummyCollections}
        onMerge={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(screen.getByTestId('merge-collections-error')).toBeTruthy();
    expect(screen.getByText('Network error while merging')).toBeTruthy();
  });
});
