# Expo SDK 58 upgrade

The mobile app uses Expo 58.0.6, React 19.3.0, and React Native
0.88.0-rc.3, as selected by Expo's SDK 58 compatibility map. React Native is
still a release candidate in this package set; this change needs native release
validation before shipping.

Expo modules, Router, animation peers, Metro, React types, and the React Native
Jest preset are upgraded together. Regenerate native projects with `expo prebuild`
after installing the lockfile; generated Android/iOS directories remain ignored.

## Compatibility ports

- React Native removed `InteractionManager`. Graph layout now starts from
  `requestIdleCallback`, with a timer fallback for browsers without that API,
  and cancels scheduled work on cleanup.
- Native component refs use `React.ComponentRef`, and image/back-handler mocks
  use the new public event types.
- `expo-share-intent` 8.0.1 officially targets SDK 57. Its checked-in patch is a
  local SDK 58 port: retain the Android capture fixes, compile the diagnostic
  journal from the actual Android source directory, and use SDK 58 Expo
  dependencies. The package's Expo peer and the narrowly scoped pnpm peer rule
  reflect this local port; they are not a claim of upstream SDK 58 support.
- The custom share receiver plugin imports `expo/config-plugins`.
- Required native font and configuration plugins are listed explicitly.

## Version checker exceptions

`expo.install.exclude` contains three deliberate exceptions:

- `jest` and `@types/jest`: the SDK version map recommends Jest 29, but
  `jest-expo` 58.0.8 requires Jest 30. The component test toolchain follows the
  preset's actual peer requirement.
- `react-native-view-shot`: Expo recommends 5.1.1, whose source types use removed
  React Native component and Codegen types. Version 6.1.0 supports the new refs;
  its web peer `html2canvas-pro` is installed explicitly.

Expo's SDK map selects `react-native-worklets` 0.13.0, while
`expo-modules-core` 58.0.14 still declares an optional worklets peer through
0.10. This upstream metadata discrepancy remains visible during installation.
Expo Doctor also reports the existing `posthog-react-native-session-replay`
package as unmaintained; it has not been replaced as part of this SDK upgrade.

## Verification

Run `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`CI=1 pnpm test:components`, and `expo install --check`. Validate production web
and native exports, then compile Android against the generated SDK 58 project.
Native compilation requires the Android SDK platform selected by the new template
(currently `platforms;android-37.0`), in a writable SDK directory.

A JavaScript/native export or config prebuild does not verify device behavior.
Before release, smoke-test native share capture, cold launch, SQLite persistence,
screenshot feedback, notification permission, and graph interaction on Android
and iOS.
