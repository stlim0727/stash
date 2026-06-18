import { Redirect } from 'expo-router';

// Custom-scheme deep links can leak into Expo Router and land on the default
// "Unmatched Route" screen. The clearest example is `expo-share-intent`, which
// launches the app with `stash://dataUrl=...` when a URL is shared in; there is
// no route for that path, so without an absorber the user would be stranded on
// the not-found screen (previously masked only because the share handler always
// navigated to the Inbox).
//
// Redirecting every unmatched route to the Inbox keeps a leaked link — share,
// OAuth callback, or anything future — from ever surfacing the broken screen,
// regardless of whether the share handler chooses to navigate. Mirrors the
// dedicated absorber in `auth/callback`.
export default function NotFound() {
  return <Redirect href="/" />;
}
