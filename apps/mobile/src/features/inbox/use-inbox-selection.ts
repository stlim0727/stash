import {
  ALL_FILTER,
  type InboxFilter
} from '@/domain/filter';
import { countTagsForBookmarks } from '@/domain/tag-counts';
import type { Bookmark, Collection, Tag } from '@/domain/types';
import {
  type ViewMode
} from '@/domain/view-mode';
import type { TFunction } from '@/i18n/translate';
import { type SheetAction } from '@/ui/ActionSheet';
import type { CaptureToastAction } from '@/ui/capture-toast';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  useCallback,
  useEffect,
  useMemo
} from 'react';
import {
  Alert,
  Platform,
  TextInput
} from 'react-native';

interface Dependencies {
  setSelectionMode: Dispatch<SetStateAction<boolean>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setBulkMoveSheetOpen: Dispatch<SetStateAction<boolean>>;
  setNewFolderDialogOpen: Dispatch<SetStateAction<boolean>>;
  setBulkMoveFolderCreateTarget: Dispatch<SetStateAction<string[] | null>>;
  setBulkTagDialogOpen: Dispatch<SetStateAction<boolean>>;
  setBulkTagError: Dispatch<SetStateAction<string | null>>;
  clearBlurHide: () => void;
  setSearchFocused: Dispatch<SetStateAction<boolean>>;
  searchRef: RefObject<React.ComponentRef<typeof TextInput> | null>;
  searchOpen: boolean;
  searching: boolean;
  closeSearch: () => void;
  visible: Bookmark[];
  selectedIds: Set<string>;
  setFolderSelectionMode: Dispatch<SetStateAction<boolean>>;
  setSelectedFolderIds: Dispatch<SetStateAction<Set<string>>>;
  collections: Collection[];
  selectedFolderIds: Set<string>;
  setRenameTarget: Dispatch<SetStateAction<Collection | null>>;
  setRenameError: Dispatch<SetStateAction<string | null>>;
  setRenameDialogOpen: Dispatch<SetStateAction<boolean>>;
  renameTarget: Collection | null;
  setRenameBusy: Dispatch<SetStateAction<boolean>>;
  renameCollection: (collectionId: string, name: string) => Promise<{ collection?: Collection; error?: string; }>;
  showToast: (message: string, action?: CaptureToastAction) => void;
  t: TFunction;
  setDeleteTargets: Dispatch<SetStateAction<Collection[]>>;
  setDeleteDialogOpen: Dispatch<SetStateAction<boolean>>;
  deleteTargets: Collection[];
  setDeleteBusy: Dispatch<SetStateAction<boolean>>;
  deleteCollection: (collectionId: string, action: "uncategorize" | "trash") => Promise<{ error?: string; }>;
  deleteCollections: (collectionIds: string[], action: "uncategorize" | "trash") => Promise<{ error?: string; }>;
  folderSelectionMode: boolean;
  filter: InboxFilter;
  setFilter: Dispatch<SetStateAction<InboxFilter>>;
  setMergeSources: Dispatch<SetStateAction<Collection[]>>;
  setMergeError: Dispatch<SetStateAction<string | null>>;
  setMergeDialogOpen: Dispatch<SetStateAction<boolean>>;
  mergeSources: Collection[];
  setMergeBusy: Dispatch<SetStateAction<boolean>>;
  mergeCollections: (sourceCollectionIds: string[], targetCollectionId: string) => Promise<{ error?: string; }>;
  inbox: Bookmark[];
  folderMenuItem: Collection | null;
  setFolderMenuItem: Dispatch<SetStateAction<Collection | null>>;
  viewMode: ViewMode;
  selectionMode: boolean;
  isResettingLibrary: boolean;
  bulkRefreshing: boolean;
  setBulkRefreshing: Dispatch<SetStateAction<boolean>>;
  refreshBookmarkPreview: (bookmarkId: string) => Promise<string | null>;
  trashBookmark: (id: string) => void;
  restoreBookmark: (id: string) => void;
  assignCollection: (bookmarkId: string, collectionId: string | null, source?: "user_edit" | "ai_apply") => void;
  getTagsForBookmark: (id: string) => Tag[];
  setBulkTagBusy: Dispatch<SetStateAction<boolean>>;
  addTagsToBookmarks: (bookmarkIds: string[], names: string[]) => Promise<string | null>;
}

export function useInboxSelection({
  setSelectionMode,
  setSelectedIds,
  setBulkMoveSheetOpen,
  setNewFolderDialogOpen,
  setBulkMoveFolderCreateTarget,
  setBulkTagDialogOpen,
  setBulkTagError,
  clearBlurHide,
  setSearchFocused,
  searchRef,
  searchOpen,
  searching,
  closeSearch,
  visible,
  selectedIds,
  setFolderSelectionMode,
  setSelectedFolderIds,
  collections,
  selectedFolderIds,
  setRenameTarget,
  setRenameError,
  setRenameDialogOpen,
  renameTarget,
  setRenameBusy,
  renameCollection,
  showToast,
  t,
  setDeleteTargets,
  setDeleteDialogOpen,
  deleteTargets,
  setDeleteBusy,
  deleteCollection,
  deleteCollections,
  folderSelectionMode,
  filter,
  setFilter,
  setMergeSources,
  setMergeError,
  setMergeDialogOpen,
  mergeSources,
  setMergeBusy,
  mergeCollections,
  inbox,
  folderMenuItem,
  setFolderMenuItem,
  viewMode,
  selectionMode,
  isResettingLibrary,
  bulkRefreshing,
  setBulkRefreshing,
  refreshBookmarkPreview,
  trashBookmark,
  restoreBookmark,
  assignCollection,
  getTagsForBookmark,
  setBulkTagBusy,
  addTagsToBookmarks,
}: Dependencies) {

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkMoveSheetOpen(false);
    setNewFolderDialogOpen(false);
    setBulkMoveFolderCreateTarget(null);
    setBulkTagDialogOpen(false);
    setBulkTagError(null);
  }, []);

  const enterSelectionMode = useCallback(
    (initialId?: string) => {
      clearBlurHide();
      setSearchFocused(false);
      searchRef.current?.blur();
      if (searchOpen && !searching) {
        closeSearch();
      }
      setSelectionMode(true);
      setSelectedIds(initialId ? new Set([initialId]) : new Set());
    },
    [searchOpen, searching, closeSearch, clearBlurHide],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allVisibleSelected = useMemo(
    () => visible.length > 0 && visible.every((b) => selectedIds.has(b.id)),
    [visible, selectedIds],
  );

  const toggleSelectAll = useCallback(() => {
    if (visible.length === 0) {
      return;
    }
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const b of visible) {
          next.delete(b.id);
        }
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const b of visible) {
          next.add(b.id);
        }
        return next;
      });
    }
  }, [allVisibleSelected, visible]);

  const exitFolderSelectionMode = useCallback(() => {
    setFolderSelectionMode(false);
    setSelectedFolderIds(new Set());
  }, []);

  const enterFolderSelectionMode = useCallback(
    (initialId?: string) => {
      clearBlurHide();
      setSearchFocused(false);
      searchRef.current?.blur();
      if (searchOpen && !searching) {
        closeSearch();
      }
      setFolderSelectionMode(true);
      setSelectedFolderIds(initialId ? new Set([initialId]) : new Set());
    },
    [searchOpen, searching, closeSearch, clearBlurHide],
  );

  const toggleFolderSelect = useCallback((id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectableCollectionIds = useMemo(() => {
    return collections
      .filter((c) => c.name?.trim())
      .map((c) => c.id);
  }, [collections]);

  const allFoldersSelected = useMemo(
    () =>
      selectableCollectionIds.length > 0 &&
      selectableCollectionIds.every((id) => selectedFolderIds.has(id)),
    [selectableCollectionIds, selectedFolderIds],
  );

  const toggleSelectAllFolders = useCallback(() => {
    if (selectableCollectionIds.length === 0) {
      return;
    }
    if (allFoldersSelected) {
      setSelectedFolderIds(new Set());
    } else {
      setSelectedFolderIds(new Set(selectableCollectionIds));
    }
  }, [allFoldersSelected, selectableCollectionIds]);

  const openRenameDialog = useCallback((collection: Collection) => {
    setRenameTarget(collection);
    setRenameError(null);
    setRenameDialogOpen(true);
  }, []);

  const handleRenameFolder = useCallback(
    async (newName: string) => {
      if (!renameTarget) {
        return;
      }
      setRenameBusy(true);
      setRenameError(null);
      try {
        const res = await renameCollection(renameTarget.id, newName);
        if (res.error) {
          setRenameError(res.error);
          return;
        }
        setRenameDialogOpen(false);
        setRenameTarget(null);
        showToast(t('toast.collectionRenamed', { name: newName }));
      } catch (err: any) {
        setRenameError(err?.message || t('common.somethingWentWrong'));
      } finally {
        setRenameBusy(false);
      }
    },
    [renameTarget, renameCollection, showToast, t],
  );

  const openDeleteFolderDialog = useCallback((targets: Collection[]) => {
    setDeleteTargets(targets);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteFolders = useCallback(
    async (action: 'uncategorize' | 'trash') => {
      if (deleteTargets.length === 0) {
        return;
      }
      setDeleteBusy(true);
      try {
        if (deleteTargets.length === 1) {
          const res = await deleteCollection(deleteTargets[0].id, action);
          if (res.error) {
            Alert.alert(t('common.error'), res.error);
            return;
          }
          showToast(t('toast.collectionDeleted'));
        } else {
          const ids = deleteTargets.map((c) => c.id);
          const res = await deleteCollections(ids, action);
          if (res.error) {
            Alert.alert(t('common.error'), res.error);
            return;
          }
          showToast(t('toast.collectionsDeleted', { count: ids.length }));
        }
        setDeleteDialogOpen(false);
        const deletedIds = new Set(deleteTargets.map((c) => c.id));
        setDeleteTargets([]);
        if (folderSelectionMode) {
          exitFolderSelectionMode();
        }
        if (filter.kind === 'collection' && deletedIds.has(filter.id)) {
          setFilter(ALL_FILTER);
        }
      } catch (err: any) {
        Alert.alert(t('common.error'), err?.message || t('common.somethingWentWrong'));
      } finally {
        setDeleteBusy(false);
      }
    },
    [deleteTargets, deleteCollection, deleteCollections, folderSelectionMode, exitFolderSelectionMode, filter, showToast, t],
  );

  const openMergeFolderDialog = useCallback((sources: Collection[]) => {
    setMergeSources(sources);
    setMergeError(null);
    setMergeDialogOpen(true);
  }, []);

  const handleMergeFolders = useCallback(
    async (targetCollectionId: string) => {
      if (mergeSources.length === 0) {
        return;
      }
      setMergeBusy(true);
      setMergeError(null);
      try {
        const sourceIds = mergeSources.map((c) => c.id);
        const res = await mergeCollections(sourceIds, targetCollectionId);
        if (res.error) {
          setMergeError(res.error);
          return;
        }
        setMergeDialogOpen(false);
        setMergeSources([]);
        if (folderSelectionMode) {
          exitFolderSelectionMode();
        }
        const targetCol = collections.find((c) => c.id === targetCollectionId);
        showToast(t('toast.collectionsMerged', { name: targetCol?.name ?? '' }));
        if (filter.kind === 'collection' && sourceIds.includes(filter.id)) {
          setFilter({ kind: 'collection', id: targetCollectionId });
        }
      } catch (err: any) {
        setMergeError(err?.message || t('common.somethingWentWrong'));
      } finally {
        setMergeBusy(false);
      }
    },
    [mergeSources, mergeCollections, folderSelectionMode, exitFolderSelectionMode, collections, filter, showToast, t],
  );

  const deleteBookmarkCount = useMemo(() => {
    if (deleteTargets.length === 0) {
      return 0;
    }
    const targetIds = new Set(deleteTargets.map((c) => c.id));
    return inbox.filter((b) => b.collection_id && targetIds.has(b.collection_id)).length;
  }, [deleteTargets, inbox]);

  const availableMergeTargets = useMemo(() => {
    if (mergeSources.length === 1) {
      return collections.filter((c) => c.id !== mergeSources[0].id);
    }
    if (mergeSources.length > 1) {
      return mergeSources;
    }
    return [];
  }, [mergeSources, collections]);

  const folderMenuActions = useMemo<SheetAction[]>(() => {
    const item = folderMenuItem;
    if (!item) {
      return [];
    }
    const actions: SheetAction[] = [
      {
        key: 'select',
        label: t('folder.selectAction'),
        icon: 'checkbox-outline',
        onPress: () => {
          setFolderMenuItem(null);
          enterFolderSelectionMode(item.id);
        },
      },
      {
        key: 'rename',
        label: t('folder.rename'),
        icon: 'pencil-outline',
        onPress: () => {
          setFolderMenuItem(null);
          openRenameDialog(item);
        },
      },
    ];
    if (collections.length >= 2) {
      actions.push({
        key: 'merge',
        label: t('folder.merge'),
        icon: 'git-merge-outline',
        onPress: () => {
          setFolderMenuItem(null);
          openMergeFolderDialog([item]);
        },
      });
    }
    actions.push({
      key: 'delete',
      label: t('folder.delete'),
      icon: 'trash-outline',
      destructive: true,
      onPress: () => {
        setFolderMenuItem(null);
        openDeleteFolderDialog([item]);
      },
    });
    return actions;
  }, [folderMenuItem, collections.length, t, enterFolderSelectionMode, openRenameDialog, openMergeFolderDialog, openDeleteFolderDialog]);

  useEffect(() => {
    if (viewMode !== 'folder' && folderSelectionMode) {
      exitFolderSelectionMode();
    }
    if (viewMode === 'folder' && selectionMode) {
      exitSelectionMode();
    }
  }, [viewMode, folderSelectionMode, selectionMode, exitFolderSelectionMode, exitSelectionMode]);

  useEffect(() => {
    if (isResettingLibrary) {
      exitSelectionMode();
      exitFolderSelectionMode();
    }
  }, [isResettingLibrary, exitSelectionMode, exitFolderSelectionMode]);

  useEffect(() => {
    if (
      Platform.OS !== 'web' ||
      (!selectionMode && !folderSelectionMode) ||
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function'
    ) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (folderSelectionMode) {
          exitFolderSelectionMode();
        }
        if (selectionMode) {
          exitSelectionMode();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectionMode, folderSelectionMode, exitSelectionMode, exitFolderSelectionMode]);

  const handleBulkRefresh = useCallback(async () => {
    if (selectedIds.size === 0 || bulkRefreshing) {
      return;
    }
    const selectedItems = inbox.filter((b) => selectedIds.has(b.id));
    const urlItems = selectedItems.filter((b) => Boolean(b.url));
    if (urlItems.length === 0) {
      showToast(t('toast.noPreviewsToRefresh'));
      exitSelectionMode();
      return;
    }
    setBulkRefreshing(true);
    try {
      let refreshedCount = 0;
      const results = await Promise.allSettled(
        urlItems.map((b) => refreshBookmarkPreview(b.id)),
      );
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value === null) {
          refreshedCount++;
        }
      }
      showToast(
        t('toast.previewRefreshedCount', {
          count: refreshedCount,
        }),
      );
    } finally {
      setBulkRefreshing(false);
      exitSelectionMode();
    }
  }, [selectedIds, bulkRefreshing, inbox, showToast, t, exitSelectionMode, refreshBookmarkPreview]);

  const handleBulkDelete = useCallback(() => {
    if (selectedIds.size === 0) {
      return;
    }
    const idsToTrash = Array.from(selectedIds);
    const count = idsToTrash.length;

    const performDelete = () => {
      for (const id of idsToTrash) {
        trashBookmark(id);
      }
      exitSelectionMode();
      showToast(t('toast.trashedCount', { count }), {
        label: t('common.undo'),
        onPress: () => {
          for (const id of idsToTrash) {
            restoreBookmark(id);
          }
        },
      });
    };

    if (Platform.OS === 'web') {
      if (typeof confirm === 'undefined' || confirm(t('inbox.bulkDeleteConfirm', { count }))) {
        performDelete();
      }
      return;
    }

    Alert.alert(
      t('inbox.bulkDeleteTitle'),
      t('inbox.bulkDeleteConfirm', { count }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: performDelete },
      ],
    );
  }, [selectedIds, trashBookmark, restoreBookmark, exitSelectionMode, showToast, t]);

  const handleOpenBulkMove = useCallback(() => {
    if (selectedIds.size === 0) {
      return;
    }
    setBulkMoveSheetOpen(true);
  }, [selectedIds]);

  const handleBulkMoveToCollection = useCallback(
    (collectionId: string | null) => {
      const idsToMove = Array.from(selectedIds);
      for (const id of idsToMove) {
        assignCollection(id, collectionId);
      }
      setBulkMoveSheetOpen(false);
      exitSelectionMode();
      if (collectionId === null) {
        showToast(t('toast.movedToInbox', { count: idsToMove.length }));
      } else {
        const col = collections.find((c) => c.id === collectionId);
        showToast(
          t('toast.movedToCollection', {
            count: idsToMove.length,
            name: col?.name ?? '',
          }),
        );
      }
    },
    [selectedIds, assignCollection, exitSelectionMode, showToast, collections, t],
  );

  const existingTagsForBulk = useMemo(() => {
    const counts = countTagsForBookmarks(
      inbox.map((b) => b.id),
      getTagsForBookmark,
    );
    return counts.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [inbox, getTagsForBookmark]);

  const handleOpenBulkTag = useCallback(() => {
    if (selectedIds.size === 0) {
      return;
    }
    setBulkTagError(null);
    setBulkTagDialogOpen(true);
  }, [selectedIds]);

  const handleBulkApplyTag = useCallback(
    async (tagName: string) => {
      const clean = tagName.trim().replace(/^#+/, '');
      if (!clean) {
        return;
      }
      const ids = Array.from(selectedIds);
      if (ids.length === 0) {
        return;
      }
      setBulkTagBusy(true);
      setBulkTagError(null);
      const error = await addTagsToBookmarks(ids, [clean]);
      setBulkTagBusy(false);
      if (error) {
        setBulkTagError(error);
        return;
      }
      setBulkTagDialogOpen(false);
      exitSelectionMode();
      showToast(t('toast.tagsAdded', { count: ids.length, tag: clean }));
    },
    [selectedIds, addTagsToBookmarks, exitSelectionMode, showToast, t],
  );
  return { exitSelectionMode, enterSelectionMode, toggleSelect, allVisibleSelected, toggleSelectAll, exitFolderSelectionMode, enterFolderSelectionMode, toggleFolderSelect, selectableCollectionIds, allFoldersSelected, toggleSelectAllFolders, openRenameDialog, handleRenameFolder, openDeleteFolderDialog, handleDeleteFolders, openMergeFolderDialog, handleMergeFolders, deleteBookmarkCount, availableMergeTargets, folderMenuActions, handleBulkRefresh, handleBulkDelete, handleOpenBulkMove, handleBulkMoveToCollection, existingTagsForBulk, handleOpenBulkTag, handleBulkApplyTag };
}
