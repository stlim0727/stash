import { type CollectionColorKey } from '@/domain/collection-color';
import {
  type InboxFilter
} from '@/domain/filter';
import type { Bookmark } from '@/domain/types';
import { Ionicons } from '@expo/vector-icons';

export interface FacetChip {
  key: string;
  label: string;
  filter: InboxFilter;
  icon?: keyof typeof Ionicons.glyphMap;
  // How many bookmarks the facet holds. Set for the "container" chips (folders
  // and the Inbox/no-collection set) so their weight is visible at a glance;
  // left undefined for #tag chips (the tag cloud is their frequency view).
  count?: number;
}

// A filler cell used to pad the last row of the multi-column card grid so the
// real cards on that row keep their column width. Never rendered as a card — the
// renderItem short-circuits it to an empty flex spacer.
export type GridPlaceholder = { id: string; __placeholder: true; role?: 'selected-row' };

export type InlineDetailItem = { id: string; __inlineDetail: true; bookmarkId: string; fullWidth?: boolean };

// Folder View tile — either a facet (the uncollected bucket or a real
// Collection, both tappable via `filter`) or the trailing "new folder"
// affordance (`kind: 'new'`, no `filter`).
export type FolderTileItem = {
  id: string;
  collectionId?: string;
  __folderTile: true;
  kind: 'uncollected' | 'collection' | 'new';
  label?: string;
  count?: number;
  filter?: InboxFilter;
  colorKey?: CollectionColorKey;
};

export type InboxListItem = Bookmark | GridPlaceholder | InlineDetailItem | FolderTileItem;
