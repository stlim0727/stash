import { Redirect, useRouter } from 'expo-router';
import { useEffect } from 'react';

// Custom-scheme deep links can leak into Expo Router and land on the default
// "Unmatched Route" screen. The clearest example is `expo-share-intent`, which
// launches the app with `stash://dataUrl=...` when a URL is shared in; there is
// no route for that path, so without an absorber the user would be stranded on
// the not-found screen (previously masked only because the share handler always
// navigated to the Inbox).
//
// Natural behavior: if a screen is already on the stack — a share arrived while
// the user was mid-task in Stash — pop back to it so the leaked link doesn't
// disrupt them (the share is confirmed by a toast, nothing more). On a cold
// start there is nothing to return to, so fall back to the Inbox, where Stash
// has to show something. Mirrors the dedicated absorber in `auth/callback`.
export default function NotFound() {
  const router = useRouter();
  const canGoBack = router.canGoBack();

  useEffect(() => {
    if (canGoBack) {
      router.back();
    }
  }, [canGoBack, router]);

  return canGoBack ? null : <Redirect href="/" />;
}
