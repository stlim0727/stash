import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_TOOLS, describeAction, findTool, isMutating } from './chat-tools.ts';

test('read tools are not gated; mutating tools are', () => {
  assert.equal(isMutating('search_bookmarks'), false);
  assert.equal(isMutating('list_collections'), false);
  assert.equal(isMutating('create_bookmark'), true);
  assert.equal(isMutating('trash_bookmark'), true);
});

test('unknown tools fail safe (treated as mutating → require confirm)', () => {
  assert.equal(isMutating('drop_database'), true);
  assert.equal(findTool('drop_database'), undefined);
});

test('every registered tool has a kind and a non-empty description', () => {
  for (const tool of CHAT_TOOLS) {
    assert.ok(tool.description.length > 0, tool.name);
    assert.ok(tool.kind === 'read' || tool.kind === 'mutating', tool.name);
    assert.equal(tool.parameters.type, 'object', tool.name);
  }
});

test('describeAction produces human confirm copy per mutating tool', () => {
  assert.match(describeAction('create_bookmark', { url: 'https://x.com' }), /https:\/\/x\.com/);
  assert.match(describeAction('add_tags', { tags: ['news', 'tech'] }), /news, tech/);
  assert.match(describeAction('trash_bookmark', { bookmark_id: 'b1' }), /Trash/);
  assert.match(describeAction('set_collection', { bookmark_id: 'b1', collection_id: null }), /Remove/);
});
