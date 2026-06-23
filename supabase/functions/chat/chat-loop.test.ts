import assert from 'node:assert/strict';
import test from 'node:test';

import { runChatTurn, type ToolExecutor } from './chat-loop.ts';
import type { Completion, ChatProvider } from './chat-provider.ts';
import type { ToolCall, Turn } from './chat-protocol.ts';

/** A ChatProvider that replays a scripted list of completions, one per step. */
function scriptedProvider(script: Completion[]): ChatProvider {
  let i = 0;
  return {
    model: 'fake',
    complete: async () => script[i++] ?? { text: 'done', tool_calls: [] },
  };
}

/** Records which tool calls were executed; returns a canned result. */
function recordingExecutor(): { executor: ToolExecutor; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const executor: ToolExecutor = async (call) => {
    calls.push(call);
    return { call_id: call.id, output: { ran: call.name } };
  };
  return { executor, calls };
}

const userTurn = (content: string): Turn => ({ role: 'user', content });

test('a plain answer returns status=message and appends the assistant turn', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await runChatTurn({
    provider: scriptedProvider([{ text: 'Hello!', tool_calls: [] }]),
    system: 'sys',
    transcript: [userTurn('hi')],
    execute: executor,
  });
  assert.equal(result.status, 'message');
  assert.equal(calls.length, 0);
  if (result.status === 'message') {
    assert.equal(result.text, 'Hello!');
    assert.equal(result.transcript.at(-1)?.role, 'assistant');
  }
});

test('read tool calls run automatically, then the model answers', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await runChatTurn({
    provider: scriptedProvider([
      { text: '', tool_calls: [{ id: 'c1', name: 'search_bookmarks', input: { query: 'rag' } }] },
      { text: 'Found 3.', tool_calls: [] },
    ]),
    system: 'sys',
    transcript: [userTurn('what did I save about rag?')],
    execute: executor,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'search_bookmarks');
  assert.equal(result.status, 'message');
});

test('a mutating tool call pauses for confirmation and executes nothing', async () => {
  const { executor, calls } = recordingExecutor();
  const result = await runChatTurn({
    provider: scriptedProvider([
      { text: 'Saving that.', tool_calls: [{ id: 'm1', name: 'create_bookmark', input: { url: 'https://a.com' } }] },
    ]),
    system: 'sys',
    transcript: [userTurn('save https://a.com')],
    execute: executor,
  });
  assert.equal(result.status, 'confirmation_required');
  assert.equal(calls.length, 0, 'must not execute before approval');
  if (result.status === 'confirmation_required') {
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0].name, 'create_bookmark');
    assert.match(result.pending[0].summary, /https:\/\/a\.com/);
    // The proposing assistant turn is in the transcript so the client can resend it.
    assert.equal(result.transcript.at(-1)?.role, 'assistant');
  }
});

test('an approved decision executes the pending mutating call, then continues', async () => {
  const { executor, calls } = recordingExecutor();
  // Transcript ends with the assistant turn that proposed the mutating call.
  const transcript: Turn[] = [
    userTurn('save https://a.com'),
    {
      role: 'assistant',
      content: 'Saving that.',
      tool_calls: [{ id: 'm1', name: 'create_bookmark', input: { url: 'https://a.com' } }],
    },
  ];
  const result = await runChatTurn({
    provider: scriptedProvider([{ text: 'Saved!', tool_calls: [] }]),
    system: 'sys',
    transcript,
    decision: { call_id: 'm1', decision: 'approved' },
    execute: executor,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_bookmark');
  assert.equal(result.status, 'message');
});

test('a rejected decision records the refusal without executing', async () => {
  const { executor, calls } = recordingExecutor();
  const transcript: Turn[] = [
    userTurn('delete that'),
    {
      role: 'assistant',
      content: 'Trashing it.',
      tool_calls: [{ id: 'm9', name: 'trash_bookmark', input: { bookmark_id: 'b1' } }],
    },
  ];
  const result = await runChatTurn({
    provider: scriptedProvider([{ text: 'Okay, I left it.', tool_calls: [] }]),
    system: 'sys',
    transcript,
    decision: { call_id: 'm9', decision: 'rejected' },
    execute: executor,
  });
  assert.equal(calls.length, 0, 'rejected action must not run');
  assert.equal(result.status, 'message');
  // A tool result recording the decline was fed back to the model.
  const toolTurn = result.transcript.find((t) => t.role === 'tool');
  assert.ok(toolTurn);
});

test('the loop stops at maxSteps instead of looping forever', async () => {
  const { executor } = recordingExecutor();
  // Provider keeps requesting the same read tool every step.
  const provider: ChatProvider = {
    model: 'fake',
    complete: async () => ({
      text: '',
      tool_calls: [{ id: `c${Math.random()}`, name: 'list_tags', input: {} }],
    }),
  };
  const result = await runChatTurn({
    provider,
    system: 'sys',
    transcript: [userTurn('loop')],
    execute: executor,
    maxSteps: 3,
  });
  assert.equal(result.status, 'message');
});
