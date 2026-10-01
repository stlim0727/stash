import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notifyDetailMounted,
  registerDetailOpenListener,
} from './detail-navigation-signal.ts';

test('detail navigation signal notifies registered listeners and supports unregister', () => {
  const events: string[] = [];
  const unsubscribe = registerDetailOpenListener((id) => {
    events.push(id);
  });

  notifyDetailMounted('bm-1');
  notifyDetailMounted('bm-2');

  assert.deepEqual(events, ['bm-1', 'bm-2']);

  unsubscribe();

  notifyDetailMounted('bm-3');
  assert.deepEqual(events, ['bm-1', 'bm-2']);
});
