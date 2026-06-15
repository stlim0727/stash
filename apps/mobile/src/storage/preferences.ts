import { repository } from '@/storage/repository';

/**
 * Small key/value preference accessor backed by the durable repository meta
 * store (the same store sync watermarks use). Kept separate from the bookmarks
 * store so UI preferences don't widen that API.
 */
export async function getPreference(key: string): Promise<string | null> {
  return repository.getMeta(key);
}

export async function setPreference(key: string, value: string): Promise<void> {
  await repository.setMeta(key, value);
}
