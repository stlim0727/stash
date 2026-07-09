import type { FeedbackScreenshot } from '@/feedback/screenshot';

let pendingScreenshot: FeedbackScreenshot | null = null;
let pendingSource: FeedbackSourceContext | null = null;

export interface FeedbackSourceContext {
  route: string;
  surface: string;
}

export function setPendingFeedbackScreenshot(screenshot: FeedbackScreenshot | null): void {
  pendingScreenshot = screenshot;
}

export function setPendingFeedbackSource(source: FeedbackSourceContext | null): void {
  pendingSource = source;
}

export function getPendingFeedbackSource(): FeedbackSourceContext | null {
  return pendingSource;
}

export function getPendingFeedbackScreenshot(): FeedbackScreenshot | null {
  return pendingScreenshot;
}

export function clearPendingFeedbackScreenshot(): void {
  pendingScreenshot = null;
  pendingSource = null;
}
