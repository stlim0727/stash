import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { ChatTurn, ChatTurnResult } from '@/api/chat';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockSession = {
  access_token: 'token',
  refresh_token: 'refresh',
  token_type: 'bearer',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-test' },
};

jest.mock('@/supabase/auth-provider', () => ({
  useSupabaseAuth: () => ({
    status: 'anonymous',
    session: mockSession,
    userId: 'user-test',
    isSignedIn: true,
    ensureAnonymousSession: async () => mockSession,
    signIn: async () => mockSession,
    signOut: async () => {},
  }),
  SupabaseAuthProvider: ({ children }: { children: ReactNode }) => children,
}));

import ChatScreen from '@/app/chat';

test('a question shows the assistant reply', async () => {
  const send = jest.fn(
    async (messages: ChatTurn[]): Promise<ChatTurnResult> => ({
      status: 'message',
      text: 'You have 3 bookmarks about RAG.',
      transcript: [...messages, { role: 'assistant', content: 'You have 3 bookmarks about RAG.' }],
    }),
  );
  const createApi = jest.fn(() => ({ send }));

  const screen = await render(<ChatScreen createApi={createApi as never} />);

  await act(async () => {
    await fireEvent.changeText(screen.getByPlaceholderText('Ask about your bookmarks…'), 'what about rag?');
  });
  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Send message'));
  });

  await waitFor(() => expect(screen.getByText('You have 3 bookmarks about RAG.')).toBeTruthy());
  expect(screen.getByText('what about rag?')).toBeTruthy();
  expect(send).toHaveBeenCalledWith([{ role: 'user', content: 'what about rag?' }], undefined);
});

test('a mutating action pauses for confirmation and only runs on approve', async () => {
  const proposingTranscript: ChatTurn[] = [
    { role: 'user', content: 'save https://a.com' },
    {
      role: 'assistant',
      content: 'I can save that.',
      tool_calls: [{ id: 'm1', name: 'create_bookmark', input: { url: 'https://a.com' } }],
    },
  ];
  const send = jest
    .fn<Promise<ChatTurnResult>, [ChatTurn[], unknown]>()
    .mockResolvedValueOnce({
      status: 'confirmation_required',
      text: 'I can save that.',
      pending: [{ call_id: 'm1', name: 'create_bookmark', input: { url: 'https://a.com' }, summary: 'Save “https://a.com”?' }],
      transcript: proposingTranscript,
    })
    .mockResolvedValueOnce({
      status: 'message',
      text: 'Saved it.',
      transcript: [...proposingTranscript, { role: 'tool', results: [{ call_id: 'm1', output: { status: 'created' } }] }, { role: 'assistant', content: 'Saved it.' }],
    });
  const createApi = jest.fn(() => ({ send }));

  const screen = await render(<ChatScreen createApi={createApi as never} />);

  await act(async () => {
    await fireEvent.changeText(screen.getByPlaceholderText('Ask about your bookmarks…'), 'save https://a.com');
  });
  await act(async () => {
    await fireEvent.press(screen.getByLabelText('Send message'));
  });

  // The confirm card appears; nothing executed yet (no second send call).
  await waitFor(() => expect(screen.getByText('Save “https://a.com”?')).toBeTruthy());
  expect(send).toHaveBeenCalledTimes(1);

  await act(async () => {
    await fireEvent.press(screen.getByText('Approve'));
  });

  // Approving resends with the decision and surfaces the result.
  await waitFor(() => expect(screen.getByText('Saved it.')).toBeTruthy());
  expect(send).toHaveBeenLastCalledWith(proposingTranscript, { call_id: 'm1', decision: 'approved' });
});
