import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

test('withShareReceiver plugin and expo/config-plugins can be resolved from mobile plugins directory', () => {
  const pluginDir = fileURLToPath(new URL('../../plugins', import.meta.url));

  // Resolving expo/config-plugins must not throw MODULE_NOT_FOUND (prevents EAS build failures)
  assert.doesNotThrow(() => {
    require.resolve('expo/config-plugins', { paths: [pluginDir] });
  });

  const withShareReceiver = require('../../plugins/withShareReceiver.js');
  assert.strictEqual(typeof withShareReceiver, 'function');

  // Applying withShareReceiver registers the config plugin mods
  const inputConfig = {
    name: 'Keepory',
    slug: 'stash',
    android: { package: 'com.keepory.app' },
  };
  const modifiedConfig = withShareReceiver(inputConfig);
  assert.ok(modifiedConfig.mods?.android?.manifest, 'Manifest mod should be attached');
  assert.ok(modifiedConfig.mods?.android?.dangerous, 'Dangerous mod should be attached');
});
