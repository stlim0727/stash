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

  it('selects destination collection and calls onMerge', async () => {
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

    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-2'));
    });
    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-submit'));
    });

    expect(onMerge).toHaveBeenCalledWith('col-2');

    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-cancel'));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows multi-source prompt, notice and contextual confirm label when multiple sources provided', async () => {
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

    expect(screen.getByText('Select the collection to keep:')).toBeTruthy();
    expect(screen.getByTestId('merge-collections-notice')).toBeTruthy();
    expect(
      screen.getByText(
        'Bookmarks will move into “Design”, and the other selected collections will be removed. All bookmarks are safely preserved.',
      ),
    ).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-target-col-2'));
    });

    expect(
      screen.getByText(
        'Bookmarks will move into “Engineering”, and the other selected collections will be removed. All bookmarks are safely preserved.',
      ),
    ).toBeTruthy();

    expect(screen.getByText('Merge into “Engineering”')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('merge-collections-submit'));
    });

    expect(onMerge).toHaveBeenCalledWith('col-2');
  });
});
