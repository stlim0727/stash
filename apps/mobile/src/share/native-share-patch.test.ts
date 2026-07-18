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

const lifecycleListener = readFileSync(
  new URL(
    '../../node_modules/expo-share-intent/android/src/main/java/expo/modules/shareintent/ExpoShareIntentReactActivityLifecycleListener.kt',
    import.meta.url,
  ),
  'utf8',
);

const debugJournal = readFileSync(
  new URL(
    '../../node_modules/expo-share-intent/android/src/main/java/expo/modules/shareintent/ShareIntentDebugJournal.kt',
    import.meta.url,
  ),
  'utf8',
);

const parser = readFileSync(
  new URL('../../node_modules/expo-share-intent/build/utils.js', import.meta.url),
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

test('Android intents keep a privacy-safe lifecycle journal', () => {
  assert.match(lifecycleListener, /"activity_on_create"/);
  assert.match(nativeModule, /"module_on_new_intent"/);
  assert.match(nativeModule, /"module_handle"/);
  // Was 5 attempts (Sentry STASH-2T/STASH-2V: a burst of retries plus a few
  // ordinary app opens could evict every real share attempt from a 5-slot
  // window before a report ever captured it) — widened to 20.
  assert.match(debugJournal, /MAX_ATTEMPTS = 20/);
  assert.match(debugJournal, /"capturedAt"/);
  assert.match(debugJournal, /"senderPackage"/);
  assert.match(debugJournal, /"hasText"/);
  assert.match(debugJournal, /"isShareAction"/);
  assert.match(debugJournal, /intent\.getParcelableExtra<android\.net\.Uri>\(Intent\.EXTRA_REFERRER\)/);
  assert.doesNotMatch(debugJournal, /if \(!isShare\(intent\)\)/);
  assert.doesNotMatch(debugJournal, /getStringExtra\(Intent\.EXTRA_TEXT\)/);
});

test('native attempt id survives the JavaScript parser', () => {
  assert.match(nativeModule, /"attemptId" to attemptId/);
  assert.match(parser, /\.\.\.shareIntent\.meta/);
  assert.match(parser, /meta: shareIntent\?\.meta \?\? null/);
});
