import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import type { ReactNode } from 'react';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
// RN's Modal does not render its children in the jest-expo environment; pass
// them through (when visible) so the import ActionSheet's options are queryable.
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

// Stub the platform file picker so the test can drive what the user "picks".
const mockPickImportFile = jest.fn();
jest.mock('@/share/import-data', () => ({
  pickImportFile: (kind: 'json' | 'html') => mockPickImportFile(kind),
}));
// Export delivery is unused here but settings imports it; keep it inert.
jest.mock('@/share/export-data', () => ({ deliverExport: jest.fn(async () => {}) }));

import SettingsScreen from '@/app/settings';
import { BookmarksProvider } from '@/store/bookmarks';
import type { FakeRepositoryModule } from './helpers/fake-repository';

const fakeRepo = jest.requireMock('@/storage/repository') as FakeRepositoryModule;

function renderSettings() {
  return render(
    <BookmarksProvider>
      <SettingsScreen />
    </BookmarksProvider>,
  );
}

beforeEach(() => {
  mockPickImportFile.mockReset();
  fakeRepo.__reset([], { tags: [], bookmarkTags: [], collections: [] });
});

test('imports bookmarks from a Stash JSON backup and reports the count', async () => {
  const backup = JSON.stringify({
    app: 'stash',
    bookmarks: [
      { url: 'https://example.com/a', title: 'Article A' },
      { url: 'https://example.com/b', title: 'Article B' },
    ],
  });
  mockPickImportFile.mockResolvedValue({ name: 'stash-backup.json', text: backup });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

  const view = await renderSettings();
  await waitFor(() => view.getByText('Nothing to export yet'));

  await fireEvent.press(view.getByLabelText('Import data'));
  await waitFor(() => view.getByLabelText('Keepory backup (JSON)'));
  await fireEvent.press(view.getByLabelText('Keepory backup (JSON)'));

  await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  expect(mockPickImportFile).toHaveBeenCalledWith('json');
  expect(alertSpy.mock.calls[0][0]).toBe('Import complete');
  expect(alertSpy.mock.calls[0][1]).toContain('Added 2 bookmarks.');
  // The library reflects the freshly imported items.
  await waitFor(() => view.getByText('Download a bookmarks file or full backup'));

  alertSpy.mockRestore();
});

test('imports an HTML bookmarks file and dedupes against the existing library', async () => {
  const html = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<DL><p>',
    '    <DT><A HREF="https://example.com/a">Already saved</A>',
    '    <DT><A HREF="https://example.com/new">Brand new</A>',
    '</DL><p>',
  ].join('\n');
  mockPickImportFile.mockResolvedValue({ name: 'bookmarks.html', text: html });
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

  const view = await renderSettings();
  await waitFor(() => view.getByText('Nothing to export yet'));

  // Save one of the two URLs first so the import sees it as a duplicate.
  // (The JSON path already covers fresh imports; here we exercise dedupe.)
  const firstImport = JSON.stringify({ bookmarks: [{ url: 'https://example.com/a', title: 'A' }] });
  mockPickImportFile.mockResolvedValueOnce({ name: 'seed.json', text: firstImport });

  await fireEvent.press(view.getByLabelText('Import data'));
  await waitFor(() => view.getByLabelText('Keepory backup (JSON)'));
  await fireEvent.press(view.getByLabelText('Keepory backup (JSON)'));
  await waitFor(() => view.getByText('Download a bookmarks file or full backup'));

  // Now import the HTML file: one URL overlaps (duplicate), one is new.
  await fireEvent.press(view.getByLabelText('Import data'));
  await waitFor(() => view.getByLabelText('Bookmarks file (HTML)'));
  await fireEvent.press(view.getByLabelText('Bookmarks file (HTML)'));

  await waitFor(() => view.getByText('Download a bookmarks file or full backup'));
  const lastMessage = alertSpy.mock.calls.at(-1)?.[1] as string;
  expect(lastMessage).toContain('Added 1 bookmark.');
  expect(lastMessage).toContain('1 already in your library.');

  alertSpy.mockRestore();
});
