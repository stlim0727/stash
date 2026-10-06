import { useEffect } from 'react';
import { usePathname } from 'expo-router';

import { useBookmarks } from '@/store/bookmarks';
import { splashCoordinator } from './splash-coordinator';

/**
 * Observer mounted underneath BookmarksProvider to track cold-start readiness
 * and coordinate splash screen dismissal.
 */
export function SplashReadinessObserver(): null {
  const { isLoading, loadError } = useBookmarks();
  const pathname = usePathname();

  useEffect(() => {
    splashCoordinator.startWatchdog();
    return () => {
      splashCoordinator.disarmWatchdog();
    };
  }, []);

  useEffect(() => {
    splashCoordinator.updateRoute(pathname);
  }, [pathname]);

  useEffect(() => {
    splashCoordinator.updateStoreStatus({ isLoading, loadError });
  }, [isLoading, loadError]);

  return null;
}
