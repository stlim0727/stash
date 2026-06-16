import { Redirect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

// The OAuth sign-in flow (see supabase/run-oauth.ts) redirects to
// `stash://auth/callback?code=…`. That redirect is normally captured inside the
// `WebBrowser.openAuthSessionAsync` session, which exchanges the code and signs
// the user in. On Android, though — particularly on a cold start right after a
// fresh install — the OS can *also* dispatch the same custom-scheme deep link to
// the app as a launch intent. Without a matching route, Expo Router lands on the
// "Unmatched Route" not-found page even though the sign-in itself succeeded.
//
// This route exists solely to absorb that leaked redirect: it completes any
// pending auth session and bounces straight to the Inbox, so the user never sees
// the not-found screen. The actual code-for-session exchange still happens in
// run-oauth.ts.
WebBrowser.maybeCompleteAuthSession();

export default function AuthCallback() {
  return <Redirect href="/" />;
}
