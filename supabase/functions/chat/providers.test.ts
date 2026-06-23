import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAnthropicCompletion } from './claude-chat-provider.ts';
import { parseGeminiCompletion } from './gemini-chat-provider.ts';

test('parseAnthropicCompletion extracts text and tool_use blocks', () => {
  const completion = parseAnthropicCompletion({
    content: [
      { type: 'text', text: 'Let me search.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search_bookmarks', input: { query: 'rag' } },
    ],
    stop_reason: 'tool_use',
  });
  assert.equal(completion.text, 'Let me search.');
  assert.equal(completion.tool_calls.length, 1);
  assert.deepEqual(completion.tool_calls[0], {
    id: 'toolu_1',
    name: 'search_bookmarks',
    input: { query: 'rag' },
  });
});

test('parseAnthropicCompletion tolerates a plain text answer', () => {
  const completion = parseAnthropicCompletion({ content: [{ type: 'text', text: 'Done.' }] });
  assert.equal(completion.text, 'Done.');
  assert.equal(completion.tool_calls.length, 0);
});

test('parseGeminiCompletion extracts text and functionCall parts', () => {
  const completion = parseGeminiCompletion({
    candidates: [
      {
        content: {
          parts: [
            { text: 'Saving.' },
            { functionCall: { name: 'create_bookmark', args: { url: 'https://a.com' } } },
          ],
        },
      },
    ],
  });
  assert.equal(completion.text, 'Saving.');
  assert.equal(completion.tool_calls.length, 1);
  assert.equal(completion.tool_calls[0].name, 'create_bookmark');
  assert.deepEqual(completion.tool_calls[0].input, { url: 'https://a.com' });
  // Gemini supplies no call id — the adapter synthesizes a stable one.
  assert.ok(completion.tool_calls[0].id.length > 0);
});

test('parseGeminiCompletion tolerates an empty/odd body', () => {
  assert.deepEqual(parseGeminiCompletion({}), { text: '', tool_calls: [] });
  assert.deepEqual(parseGeminiCompletion({ candidates: [] }), { text: '', tool_calls: [] });
});
