-- Clear historical AI collection move suggestions on bookmarks that were already
-- filed into collections by users (STASH-74, STASH-78).
-- Lateral moves (e.g. '요리 레시피' -> '음식 및 요리' or '수영' -> '스포츠 및 건강')
-- were persisted by legacy enrichment functions and caused unconvincing suggestion noise.
update public.ai_enrichments e
set suggested_collection_id = null,
    suggested_collection_name = null,
    updated_at = now()
from public.bookmarks b
where e.bookmark_id = b.id
  and b.collection_id is not null
  and (e.suggested_collection_id is not null or e.suggested_collection_name is not null);
