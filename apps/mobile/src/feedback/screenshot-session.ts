import type { FeedbackScreenshot } from '@/feedback/screenshot';

let pendingScreenshot: FeedbackScreenshot | null = null;

export function setPendingFeedbackScreenshot(screenshot: FeedbackScreenshot | null): void {
  pendingScreenshot = screenshot;
}

export function getPendingFeedbackScreenshot(): FeedbackScreenshot | null {
  return pendingScreenshot;
}

export function clearPendingFeedbackScreenshot(): void {
  pendingScreenshot = null;
}
