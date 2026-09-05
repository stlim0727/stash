import { fireEvent, render } from '@testing-library/react-native';
import { useState } from 'react';

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
