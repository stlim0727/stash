import type { AnalyticsScreen } from './events.ts';

export function analyticsScreenForPath(pathname: string): AnalyticsScreen | null {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';

  if (path === '/') return 'inbox';
  if (path === '/add') return 'add_bookmark';
  if (path === '/settings') return 'settings';
  if (path === '/review') return 'review';
  if (path === '/report') return 'report';
  if (path === '/trash') return 'trash';
  if (path === '/browse/tags') return 'browse_tags';
  if (path === '/graph') return 'graph';
  if (/^\/bookmark\/[^/]+$/.test(path)) return 'bookmark_detail';

  return null;
}
