/**
 * Preload module for Node (--import) that registers the @/ alias resolver,
 * letting the test runner and one-off scripts execute the mobile app's
 * TypeScript directly.
 */
import { register } from 'node:module';

register('./alias-loader.mjs', import.meta.url);
