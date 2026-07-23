import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AI_SUGGESTIONS_MODES,
  AI_SUGGESTIONS_MODE_PREF_KEY,
  DEFAULT_AI_SUGGESTIONS_MODE,
  parseAiSuggestionsMode,
  serializeAiSuggestionsMode,
  type AiSuggestionsMode,
} from './ai-suggestions-pref.ts';

test('default mode is confirm (today\'s existing behavior)', () => {
  assert.equal(DEFAULT_AI_SUGGESTIONS_MODE, 'confirm');
});

test('AI_SUGGESTIONS_MODES lists all three modes in sheet order', () => {
  assert.deepEqual(AI_SUGGESTIONS_MODES, ['off', 'confirm', 'auto_accept']);
});

test('persistence key matches the agreed name', () => {
  assert.equal(AI_SUGGESTIONS_MODE_PREF_KEY, 'pref.ai.suggestions_mode');
});

test('serialize/parse round-trips every mode', () => {
  const modes: AiSuggestionsMode[] = ['off', 'confirm', 'auto_accept'];
  for (const mode of modes) {
    assert.equal(parseAiSuggestionsMode(serializeAiSuggestionsMode(mode)), mode);
  }
});

test('parse falls back to the default for missing/garbage input', () => {
  assert.equal(parseAiSuggestionsMode(null), DEFAULT_AI_SUGGESTIONS_MODE);
  assert.equal(parseAiSuggestionsMode(undefined), DEFAULT_AI_SUGGESTIONS_MODE);
  assert.equal(parseAiSuggestionsMode(''), DEFAULT_AI_SUGGESTIONS_MODE);
  assert.equal(parseAiSuggestionsMode('garbage'), DEFAULT_AI_SUGGESTIONS_MODE);
});
