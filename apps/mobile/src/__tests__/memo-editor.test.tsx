import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';
import { Linking, Platform } from 'react-native';

import { MemoEditor, type MemoDraft } from '@/ui/MemoEditor';

function Editor({ initial, commit = jest.fn() }: { initial: MemoDraft; commit?: jest.Mock }) {
  const [draft, setDraft] = useState(initial);
  return (
    <MemoEditor
      {...draft}
      label="Note"
      accessibilityLabel="Notes"
      placeholder="Add a note"
      onChange={setDraft}
      onCommit={commit}
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

test('plain text link activates via keyboard Enter and Space on web', async () => {
  const originalPlatform = Platform.OS;
  Platform.OS = 'web';
  const openUrlSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  try {
    const source = 'Visit https://keepory.app here';
    const screen = await render(<Editor initial={{ value: source, format: 'plain' }} />);
    const link = screen.getByRole('link', { name: 'https://keepory.app' });
    expect(link.props.href).toBe('https://keepory.app');

    const preventDefaultEnter = jest.fn();
    link.props.onKeyDown({ key: 'Enter', preventDefault: preventDefaultEnter });
    expect(preventDefaultEnter).toHaveBeenCalled();
    expect(openUrlSpy).toHaveBeenCalledWith('https://keepory.app');

    openUrlSpy.mockClear();
    const preventDefaultSpace = jest.fn();
    link.props.onKeyDown({ key: ' ', preventDefault: preventDefaultSpace });
    expect(preventDefaultSpace).toHaveBeenCalled();
    expect(openUrlSpy).toHaveBeenCalledWith('https://keepory.app');
  } finally {
    Platform.OS = originalPlatform;
    openUrlSpy.mockRestore();
  }
});
