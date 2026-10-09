import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Linking, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { MemoEditor, type MemoDraft } from '@/ui/MemoEditor';

const mockToastShow = jest.fn();
jest.mock('@/ui/capture-toast', () => ({
  ...jest.requireActual('@/ui/capture-toast'),
  useOptionalCaptureToast: () => ({ show: mockToastShow, isVisible: false }),
}));

function Editor({
  initial,
  commit = jest.fn(),
  onOpenLink,
}: {
  initial: MemoDraft;
  commit?: jest.Mock;
  onOpenLink?: (url: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <MemoEditor
      {...draft}
      label="Note"
      accessibilityLabel="Notes"
      placeholder="Add a note"
      onChange={setDraft}
      onCommit={commit}
      onOpenLink={onOpenLink}
    />
  );
}

test('plain text reads as selectable literal source without Markdown preview controls', async () => {
  const source = '# Heading\n\n*literal* [link](https://example.com)';
  const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);
  expect(screen.getByText(source).props.selectable).toBe(true);
  expect(screen.queryByText('Preview')).toBeNull();
  await fireEvent.press(screen.getByLabelText('Edit Note'));
  expect(screen.getByLabelText('Notes').props.value).toBe(source);
  expect(screen.queryByText('Preview')).toBeNull();
});

test('blur followed by a format switch commits the current source with its new format', async () => {
  const commit = jest.fn();
  const screen = await render(<Editor initial={{ value: 'Before', format: 'plain' }} commit={commit} />);
  await fireEvent.press(screen.getByLabelText('Edit Note'));
  const input = screen.getByLabelText('Notes');
  const source = '    code\n\n# Draft\n';
  await fireEvent.changeText(input, source);
  await fireEvent(input, 'blur');
  await fireEvent.press(screen.getByLabelText('Format for Note'));
  await fireEvent.press(screen.getByRole('radio', { name: 'Markdown' }));
  expect(commit).toHaveBeenLastCalledWith({ value: source, format: 'markdown' });
  expect(screen.getByLabelText('Notes')).toBe(input);
  expect(input.props.value).toBe(source);

  await fireEvent.press(screen.getByRole('tab', { name: 'Preview' }));
  expect(screen.getByText(source)).toBeTruthy();
  await fireEvent.press(screen.getByRole('tab', { name: 'Write' }));
  expect(screen.getByLabelText('Notes')).toBe(input);
  expect(input.props.value).toBe(source);
  await fireEvent.press(screen.getByLabelText('Finish editing Note'));
  expect(screen.queryByLabelText('Notes')).toBeNull();
  expect(commit).toHaveBeenLastCalledWith({ value: source, format: 'markdown' });
});

test('a format-only change preserves long stored source including whitespace', async () => {
  const commit = jest.fn();
  const source = `    ${'x'.repeat(10_001)}\n`;
  const screen = await render(<Editor initial={{ value: source, format: 'markdown' }} commit={commit} />);
  await fireEvent.press(screen.getByLabelText('Format for Note'));
  await fireEvent.press(screen.getByRole('radio', { name: 'Plain text' }));
  expect(commit).toHaveBeenCalledWith({ value: source, format: 'plain' });
  expect(screen.getByText(source).props.selectable).toBe(true);
});

test('plain text renders clickable URLs that open external links', async () => {
  const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const source = 'Check out https://keepory.app and https://maps.app.goo.gl/xyz today';
  const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);

  const link1 = screen.getByRole('link', { name: 'https://keepory.app' });
  const link2 = screen.getByRole('link', { name: 'https://maps.app.goo.gl/xyz' });
  expect(link1).toBeTruthy();
  expect(link2).toBeTruthy();

  await fireEvent.press(link1);
  expect(openUrlSpy).toHaveBeenCalledWith('https://keepory.app');

  await fireEvent.press(link2);
  expect(openUrlSpy).toHaveBeenCalledWith('https://maps.app.goo.gl/xyz');

  openUrlSpy.mockRestore();
});

test('plain text link relies on anchor navigation on web and supports Space activation', async () => {
  const originalPlatform = Platform.OS;
  Platform.OS = 'web';
  const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const onOpenLink = jest.fn();
  try {
    const source = 'Visit https://keepory.app here';
    const screen = await render(<Editor initial={{ value: source, format: 'plain' }} onOpenLink={onOpenLink} />);
    const link = screen.getByRole('link', { name: 'https://keepory.app' });
    expect(link.props.href).toBe('https://keepory.app');
    expect(typeof link.props.onPress).toBe('function');

    // Pressing the link on web notifies onOpenLink for access tracking without duplicating openURL
    await fireEvent.press(link);
    expect(onOpenLink).toHaveBeenCalledWith('https://keepory.app');
    expect(openUrlSpy).not.toHaveBeenCalled();

    const preventDefaultSpace = jest.fn();
    link.props.onKeyDown({ key: ' ', preventDefault: preventDefaultSpace });
    expect(preventDefaultSpace).toHaveBeenCalled();
    expect(openUrlSpy).toHaveBeenCalledWith('https://keepory.app');
    expect(onOpenLink).toHaveBeenCalledTimes(2);
  } finally {
    Platform.OS = originalPlatform;
    openUrlSpy.mockRestore();
  }
});

test('memo editor provides Copy action in header and copies on link long press on Android', async () => {
  const originalPlatform = Platform.OS;
  Platform.OS = 'android';
  mockToastShow.mockClear();
  const setStringAsync = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  try {
    const source = 'Notes with https://keepory.app link';
    const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);

    // Header copy button copies the entire memo on Android
    const copyBtn = screen.getByLabelText('Copy Note');
    expect(copyBtn).toBeTruthy();
    await fireEvent.press(copyBtn);
    expect(setStringAsync).toHaveBeenCalledWith(source);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockToastShow).toHaveBeenCalledWith('Note copied');

    mockToastShow.mockClear();
    // Link long-press copies just the link URL
    const link = screen.getByRole('link', { name: 'https://keepory.app' });
    await fireEvent(link, 'longPress');
    expect(setStringAsync).toHaveBeenCalledWith('https://keepory.app');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockToastShow).toHaveBeenCalledWith('Link copied');
  } finally {
    Platform.OS = originalPlatform;
    setStringAsync.mockRestore();
  }
});

test('memo editor handles clipboard write failure without showing success toast', async () => {
  const originalPlatform = Platform.OS;
  Platform.OS = 'android';
  mockToastShow.mockClear();
  const setStringAsync = jest.spyOn(Clipboard, 'setStringAsync').mockRejectedValue(new Error('Clipboard denied'));
  try {
    const source = 'Notes with https://keepory.app link';
    const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);

    const copyBtn = screen.getByLabelText('Copy Note');
    await fireEvent.press(copyBtn);
    expect(setStringAsync).toHaveBeenCalledWith(source);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockToastShow).not.toHaveBeenCalled();
  } finally {
    Platform.OS = originalPlatform;
    setStringAsync.mockRestore();
  }
});

test('on iOS, inline links do not intercept long press, leaving native text selection intact', async () => {
  const originalPlatform = Platform.OS;
  Platform.OS = 'ios';
  try {
    const source = 'Notes with https://keepory.app link';
    const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);
    const link = screen.getByRole('link', { name: 'https://keepory.app' });
    expect(link.props.onLongPress).toBeUndefined();
  } finally {
    Platform.OS = originalPlatform;
  }
});

test('on Android, memo body text has text role and custom copy action instead of misleading link role', async () => {
  const originalPlatform = Platform.OS;
  Platform.OS = 'android';
  mockToastShow.mockClear();
  const setStringAsync = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
  try {
    const source = 'Notes with https://keepory.app link';
    const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);
    const bodyText = screen.getByTestId('memo-reading-body');
    expect(bodyText.props.accessibilityRole).toBe('text');
    expect(bodyText.props.accessibilityActions).toEqual([{ name: 'copy', label: 'Copy' }]);

    // Triggering custom accessibility action copies the memo
    await fireEvent(bodyText, 'accessibilityAction', { nativeEvent: { actionName: 'copy' } });
    expect(setStringAsync).toHaveBeenCalledWith(source);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockToastShow).toHaveBeenCalledWith('Note copied');
  } finally {
    Platform.OS = originalPlatform;
    setStringAsync.mockRestore();
  }
});
