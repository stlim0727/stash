/**
 * Coordinates native splash screen visibility during cold startup.
 *
 * Prevents premature dismissal of the native splash screen until local durable
 * storage has settled and the initial layout is committed, eliminating the
 * visible "loading" flicker.
 *
 * Invariants:
 * 1. Startup only: dismisses splash at most once per process lifetime. Warm
 *    resume, account switches, or later syncs never re-show splash.
 * 2. Independent of network: never waits for cloud sync, Supabase auth network,
 *    AI enrichment, or remote config.
 * 3. Bounded recovery: if local storage hydration stalls past maxHoldMs (3,000ms),
 *    the splash is unconditionally dismissed to reveal whatever UI/recovery
 *    exists. A timeout never marks the library hydrated or alters durable data.
 * 4. Terminal store error: if store reports loadError, splash is dismissed
 *    immediately so the user sees the visible error recovery state.
 * 5. Layout continuity: on cold start into Inbox, holds splash until view
 *    preferences (viewMode/sort) are restored so the list does not jump between
 *    layouts on frame 1.
 * 6. Deep links: non-inbox destinations dismiss as soon as store settles without
 *    waiting for Inbox preferences.
 */

import { hideAsync as platformHideAsync } from '@/ui/splash-platform';

export const DEFAULT_SPLASH_MAX_HOLD_MS = 3_000;

export type SplashDismissReason =
  | 'inbox_ready'
  | 'route_ready'
  | 'storage_error'
  | 'timeout'
  | 'manual';

export interface SplashCoordinatorDeps {
  hideAsync?: () => Promise<boolean | void>;
  maxHoldMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class SplashCoordinator {
  private hasDismissed = false;
  private isStoreReady = false;
  private isInboxReady = false;
  private currentRoute = '/';
  private dismissReason: SplashDismissReason | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hideFn: () => Promise<boolean | void>;
  private readonly maxHoldMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(deps: SplashCoordinatorDeps = {}) {
    this.hideFn = deps.hideAsync ?? platformHideAsync;
    this.maxHoldMs = deps.maxHoldMs ?? DEFAULT_SPLASH_MAX_HOLD_MS;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  }

  /**
   * Arm the bounded fallback watchdog. If local storage hydration does not
   * settle within maxHoldMs (default 3,000ms), the splash is dismissed to
   * reveal the in-app state/error, preventing the user from being trapped.
   * A timeout never marks the library hydrated or alters durable data.
   */
  public startWatchdog(): void {
    if (this.hasDismissed || this.watchdogTimer !== null) {
      return;
    }
    this.watchdogTimer = this.setTimeoutFn(() => {
      this.watchdogTimer = null;
      void this.hideSplash('timeout');
    }, this.maxHoldMs);
  }

  public disarmWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.clearTimeoutFn(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  public updateStoreStatus(status: { isLoading: boolean; loadError: boolean }): void {
    if (this.hasDismissed) {
      return;
    }
    // Terminal storage failure: dismiss immediately to reveal error recovery UI
    if (status.loadError) {
      this.isStoreReady = true;
      void this.hideSplash('storage_error');
      return;
    }
    if (!status.isLoading) {
      this.isStoreReady = true;
      this.evaluateReadiness();
    }
  }

  public updateRoute(route: string): void {
    if (this.hasDismissed) {
      return;
    }
    this.currentRoute = route;
    this.evaluateReadiness();
  }

  public signalInboxReady(): void {
    if (this.hasDismissed) {
      return;
    }
    this.isInboxReady = true;
    this.evaluateReadiness();
  }

  private evaluateReadiness(): void {
    if (this.hasDismissed) {
      return;
    }

    if (!this.isStoreReady) {
      return;
    }

    const isInboxRoute =
      this.currentRoute === '/' ||
      this.currentRoute === '/index' ||
      this.currentRoute === 'index' ||
      this.currentRoute === '';

    if (isInboxRoute) {
      if (this.isInboxReady) {
        void this.hideSplash('inbox_ready');
      }
      return;
    }

    // Destination is non-inbox route (e.g. /add, /bookmark/[id], /settings, /auth/callback)
    void this.hideSplash('route_ready');
  }

  public async hideSplash(reason: SplashDismissReason = 'manual'): Promise<void> {
    if (this.hasDismissed) {
      return;
    }
    this.hasDismissed = true;
    this.dismissReason = reason;
    this.disarmWatchdog();
    try {
      await this.hideFn();
    } catch {
      // Rejections (e.g. already hidden, unmounted, web) safely ignored
    }
  }

  public isDismissed(): boolean {
    return this.hasDismissed;
  }

  public getDismissReason(): SplashDismissReason | null {
    return this.dismissReason;
  }

  public resetForTesting(): void {
    this.disarmWatchdog();
    this.hasDismissed = false;
    this.isStoreReady = false;
    this.isInboxReady = false;
    this.currentRoute = '/';
    this.dismissReason = null;
  }
}

export const splashCoordinator = new SplashCoordinator();
