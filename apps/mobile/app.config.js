// Dynamic Expo config: layer build-time version info over app.json.
//
// Expo loads app.json as the static config and passes it here as `config`; we
// override only the version fields so CI can stamp the release tag onto the
// build. Read by `expo prebuild` (bakes versionName/versionCode into the native
// project) and by the JS bundle (Constants.expoConfig.version in Settings).
//
//   APP_VERSION          versionName / iOS CFBundleShortVersionString (e.g.
//                        "0.1.7"). CI sets it from the git tag; when empty
//                        (local dev + rolling `dev` builds) it falls back to the
//                        version in app.json.
//   ANDROID_VERSION_CODE integer versionCode + iOS buildNumber. CI sets it to
//                        the workflow run number so every build is unique and
//                        monotonically increasing; defaults to 1 locally.
module.exports = ({ config }) => {
  const version = (process.env.APP_VERSION || config.version || '0.0.0').replace(/^v/, '');
  const versionCode = Number.parseInt(process.env.ANDROID_VERSION_CODE || '', 10) || 1;

  return {
    ...config,
    version,
    android: { ...config.android, versionCode },
    ios: { ...config.ios, buildNumber: String(versionCode) },
  };
};
