import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const nativeModule = readFileSync(
  new URL(
    '../../node_modules/expo-share-intent/android/src/main/java/expo/modules/shareintent/ExpoShareIntentModule.kt',
    import.meta.url,
  ),
  'utf8',
);

test('non-root Android shares bypass the lossy activity relaunch', () => {
  assert.match(
    nativeModule,
    /val isShareAction = intent\.action == Intent\.ACTION_SEND \|\|\s+intent\.action == Intent\.ACTION_SEND_MULTIPLE/,
  );
  assert.match(
    nativeModule,
    /if \(activity != null && !activity\.isTaskRoot && !isShareAction\)/,
  );
});
