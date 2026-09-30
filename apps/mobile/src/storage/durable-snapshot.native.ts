import { repository } from '@/storage/repository';
import type { Bookmark } from '@/domain/types';

/** Native listBookmarks reads SQLite; callers must wait for initial load. */
export async function readDurableBookmarks(): Promise<Bookmark[] | null> {
  try { return await repository.listBookmarks(); } catch { return null; }
}
