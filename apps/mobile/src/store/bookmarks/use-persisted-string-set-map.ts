import type { StringSetMap } from "@/domain/string-set-map";
import { parseStringSetMap } from "@/domain/string-set-map";
import { repository } from "@/storage/repository";
import { logStorageError } from '@/store/bookmarks/helpers';
import { ensureRepositoryReady } from '@/store/bookmarks/repository-ready';
import {
  useCallback,
  useRef,
  useState
} from "react";

/**
 * A per-bookmark `StringSetMap` mirrored into React state *and* a ref, persisted
 * to `metaKey`. The ref is updated synchronously by `apply` so the optimistic /
 * background-arrival paths can read-modify-write within a single tick (state
 * alone would lag a render); `apply` is the one persist seam. Both the
 * reviewed-suggestions and dismissed-folder stores are instances of this — it
 * collapses what were two parallel state+ref+apply+clear stacks into one.
 */
export function usePersistedStringSetMap(metaKey: string) {
  const [map, setMap] = useState<StringSetMap>({});
  const ref = useRef<StringSetMap>({});
  const apply = useCallback(
    (next: StringSetMap) => {
      ref.current = next;
      setMap(next);
      ensureRepositoryReady()
        .then(() => repository.setMeta(metaKey, JSON.stringify(next)))
        .catch((error) => logStorageError(metaKey, error));
    },
    [metaKey],
  );
  // Replace the whole map from a freshly-parsed meta blob (startup hydration) —
  // no persist, since it came straight from the store.
  const hydrate = useCallback((raw: string | null) => {
    const next = parseStringSetMap(raw);
    ref.current = next;
    setMap(next);
  }, []);
  // Forget one key's entry entirely (a deliberate "reconsider" — e.g. a manual
  // "Suggest with AI" re-run). Background sync never calls this.
  const removeKey = useCallback(
    (key: string) => {
      if (!(key in ref.current)) {
        return;
      }
      const next = { ...ref.current };
      delete next[key];
      apply(next);
    },
    [apply],
  );
  return { map, ref, apply, hydrate, removeKey };
}
