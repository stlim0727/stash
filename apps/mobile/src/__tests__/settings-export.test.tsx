import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
// RN's Modal does not render its children in the jest-expo environment; pass
// them through (when visible) so the export ActionSheet's options are queryable.
jest.mock('react-native/Libraries/Modal/Modal', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MockModal = ({ visible, children }: { visible?: boolean; children: ReactNode }) =>
    visible === false ? null : React.createElement(View, null, children);
  return { __esModule: true, default: MockModal };
});
jest.mock('@/storage/repository', () =>
  require('./helpers/fake-repository').createFakeRepositoryModule(),
);
jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'not_configured',
    session: null,
    userId: null,
    isSignedIn: false,
    message: 'not configured',
    ensureAnonymousSession: async () => null,
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@/domain/enrichment', () => ({
  enrichBookmark: async () => ({ patch: {}, metadata_status: 'complete' }),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));

const mockDeliverExport = jest.fn(async (_file: unknown) => {});
jest.mock('@/share/export-data', () => ({
  deliverExport: (file: unknown) => mockDeliverExport(file),
}));

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';
import type { Collection, Tag } from '@/domain/types';
import type { TagData } from '@/storage/types';
import type { FakeRepositoryModule } from './helpers/fake-repository';
import { makeStoredBookmark } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function makeTag(id: string, name: string): Tag {
  return {
    id,
    user_id: 'user-test',
    name,
    slug: name,
    source: 'user',
    created_at: '2026-06-12T00:00:00.000Z',
  };
}

function makeCollection(id: string, name: string): Collection {
  const now = '2026-06-12T00:00:00.000Z';
  return { id, user_id: 'user-test', name, description: null, created_at: now, updated_at: now };
}

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockDeliverExport.mockClear();
});

test('exports an HTML bookmarks file assembled from the stored library', async () => {
  const bookmark = makeStoredBookmark({
    id: '7e64cf1e-0000-4000-8000-0000000000aa',
    title: 'Local-first software',
    url: 'https://www.inkandswitch.com/local-first/',
    url_hash: 'https://www.inkandswitch.com/local-first/',
    collection_id: 'col-1',
  });
  const tagData: TagData = {
    tags: [makeTag('tag-1', 'reading')],
    bookmarkTags: [
      { bookmark_id: bookmark.id, tag_id: 'tag-1', source: 'user', confidence: null, created_at: bookmark.created_at },
    ],
    collections: [makeCollection('col-1', 'Research')],
  };
  fakeRepo.__reset([bookmark], tagData);

  const view = await renderSettings();

  // Wait for the durable store to load so the export sees the seeded bookmark.
  await waitFor(() => view.getByText('Download a bookmarks file or full backup'));

  await fireEvent.press(view.getByLabelText('Export my data'));
  await waitFor(() => view.getByLabelText('Bookmarks file (HTML)'));
  await fireEvent.press(view.getByLabelText('Bookmarks file (HTML)'));

  await waitFor(() => expect(mockDeliverExport).toHaveBeenCalledTimes(1));
  const file = mockDeliverExport.mock.calls[0][0] as {
    filename: string;
    mimeType: string;
    contents: string;
  };
  expect(file.mimeType).toBe('text/html');
  expect(file.filename).toMatch(/^stash-bookmarks-\d{4}-\d{2}-\d{2}\.html$/);
  expect(file.contents).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
  expect(file.contents).toContain('Local-first software');
  expect(file.contents).toContain('<H3'); // collection rendered as a folder
  expect(file.contents).toContain('Research');
  expect(file.contents).toContain('TAGS="reading"');
});

test('exports a JSON backup with the bookmark and its tags', async () => {
  const bookmark = makeStoredBookmark({
    id: '7e64cf1e-0000-4000-8000-0000000000bb',
    title: 'Raindrop review',
    url: 'https://raindrop.io/',
    url_hash: 'https://raindrop.io/',
  });
  const tagData: TagData = {
    tags: [makeTag('tag-2', 'tools')],
    bookmarkTags: [
      { bookmark_id: bookmark.id, tag_id: 'tag-2', source: 'user', confidence: null, created_at: bookmark.created_at },
    ],
    collections: [],
  };
  fakeRepo.__reset([bookmark], tagData);

  const view = await renderSettings();
  await waitFor(() => view.getByText('Download a bookmarks file or full backup'));

  await fireEvent.press(view.getByLabelText('Export my data'));
  await waitFor(() => view.getByLabelText('Full backup (JSON)'));
  await fireEvent.press(view.getByLabelText('Full backup (JSON)'));

  await waitFor(() => expect(mockDeliverExport).toHaveBeenCalledTimes(1));
  const file = mockDeliverExport.mock.calls[0][0] as { mimeType: string; contents: string };
  expect(file.mimeType).toBe('application/json');

  const parsed = JSON.parse(file.contents);
  expect(parsed.app).toBe('stash');
  expect(parsed.counts.bookmarks).toBe(1);
  expect(parsed.bookmarks[0].title).toBe('Raindrop review');
  expect(parsed.bookmarks[0].tags.map((t: { name: string }) => t.name)).toContain('tools');
});

test('exports a CSV table assembled from the stored library', async () => {
  const bookmark = makeStoredBookmark({
    id: '7e64cf1e-0000-4000-8000-0000000000cc',
    title: 'Local-first software',
    url: 'https://www.inkandswitch.com/local-first/',
    url_hash: 'https://www.inkandswitch.com/local-first/',
    collection_id: 'col-1',
  });
  const tagData: TagData = {
    tags: [makeTag('tag-3', 'reading')],
    bookmarkTags: [
      { bookmark_id: bookmark.id, tag_id: 'tag-3', source: 'user', confidence: null, created_at: bookmark.created_at },
    ],
    collections: [makeCollection('col-1', 'Research')],
  };
  fakeRepo.__reset([bookmark], tagData);

  const view = await renderSettings();
  await waitFor(() => view.getByText('Download a bookmarks file or full backup'));

  await fireEvent.press(view.getByLabelText('Export my data'));
  await waitFor(() => view.getByLabelText('Spreadsheet (CSV)'));
  await fireEvent.press(view.getByLabelText('Spreadsheet (CSV)'));

  await waitFor(() => expect(mockDeliverExport).toHaveBeenCalledTimes(1));
  const file = mockDeliverExport.mock.calls[0][0] as {
    filename: string;
    mimeType: string;
    contents: string;
  };
  expect(file.mimeType).toBe('text/csv');
  expect(file.filename).toMatch(/^stash-bookmarks-\d{4}-\d{2}-\d{2}\.csv$/);
  const [header, firstRow] = file.contents.split('\r\n');
  expect(header).toBe('url,title,notes,tags,collection,created_at,updated_at,is_archived');
  expect(firstRow).toContain('Local-first software');
  expect(firstRow).toContain('Research');
  expect(firstRow).toContain('reading');
});
