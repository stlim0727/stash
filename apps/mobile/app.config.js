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
//   EXPO_PUBLIC_GIT_SHA   build provenance — full commit SHA, git ref, and the
//   EXPO_PUBLIC_GIT_REF   canonical commit URL. Exposed via `extra` (read at
//   EXPO_PUBLIC_COMMIT_URL runtime through Constants.expoConfig.extra), NOT via
//   Babel's EXPO_PUBLIC_* bundle inlining: an inlined value
//   gets frozen in Metro's content-keyed transform cache and
//   then reports a stale commit on every cached CI build.
//   Routing it through `extra` shares `version`'s
//   cache-immune path, so the provenance updates each build.
//   Empty locally ⇒ the app shows a "local build" label.

const path = require("path");
const fs = require("fs");

module.exports = ({ config }) => {
  const version = (
    process.env.APP_VERSION ||
    config.version ||
    "0.0.0"
  ).replace(/^v/, "");
  const versionCode =
    Number.parseInt(process.env.ANDROID_VERSION_CODE || "", 10) || 1;
  const easProjectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    (config.extra && config.extra.eas && config.extra.eas.projectId) ||
    null;

  // Dynamically write google-services.json if passed via base64 environment variable
  const googleServicesBase64 = process.env.EXPO_PUBLIC_GOOGLE_SERVICES_BASE64;
  const googleServicesPath = path.join(__dirname, "google-services.json");
  if (googleServicesBase64) {
    try {
      fs.writeFileSync(
        googleServicesPath,
        Buffer.from(googleServicesBase64, "base64").toString("utf-8"),
      );
      console.log(
        "[build] Wrote google-services.json from EXPO_PUBLIC_GOOGLE_SERVICES_BASE64.",
      );
    } catch (err) {
      console.warn("[build] Failed to write google-services.json:", err);
    }
  }
  const hasGoogleServices = fs.existsSync(googleServicesPath);

  return {
    ...config,
    version,
    android: {
      ...config.android,
      versionCode,
      ...(hasGoogleServices
        ? { googleServicesFile: "./google-services.json" }
        : {}),
    },
    ios: { ...config.ios, buildNumber: String(versionCode) },
    extra: {
      ...config.extra,
      gitSha: process.env.EXPO_PUBLIC_GIT_SHA || null,
      gitRef: process.env.EXPO_PUBLIC_GIT_REF || null,
      commitUrl: process.env.EXPO_PUBLIC_COMMIT_URL || null,
      eas: {
        ...((config.extra && config.extra.eas) || {}),
        ...(easProjectId ? { projectId: easProjectId } : {}),
      },
    },
  };
};
