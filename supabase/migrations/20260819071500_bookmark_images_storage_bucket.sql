-- Storage bucket for user-uploaded bookmark images (image-only shares — a
-- screenshot with no link, captured via the OS share sheet). First Storage
-- bucket in this project; the `bookmarks` table already has a nullable
-- `preview_image_url` text column this feature reuses (no schema change
-- there), it is just never populated for a local-only image capture today.
--
-- Read access is PUBLIC by product decision: every other `preview_image_url`
-- in this app is a plain, unauthenticated URL (scraped OpenGraph images) used
-- directly in <Image>, with no signed-URL/refresh machinery anywhere in the
-- codebase. Matching that pattern keeps the diff small. Object paths are
-- namespaced `{user_id}/{bookmark_id}` (no extension — the object's stored
-- Content-Type header, set at upload time, is what renders it correctly, not
-- the path) — unguessable UUIDs, not enumerable, but not access-controlled
-- either; this was an explicit Chief-of-Staff -> user escalation, not a
-- default.
--
-- Write access (insert/update/delete) IS owner-scoped: the client always
-- uploads to a path whose first segment is its own auth.uid(), and these
-- policies enforce that server-side so one user can never overwrite or
-- delete another user's object even though every object is publicly
-- readable by URL.
-- Mirrors every image MIME type domain/image-share.ts's local-capture path
-- already recognizes (MIME_TO_EXT) — local capture accepts these today, so
-- cloud upload accepts the same set rather than silently stranding a subset.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bookmark-images',
  'bookmark-images',
  true,
  15728640, -- 15 MB
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'image/gif', 'image/bmp', 'image/tiff', 'image/avif', 'image/svg+xml'
  ]
)
on conflict (id) do nothing;

-- storage.objects ships with RLS already enabled by Supabase; these are the
-- policies for this bucket. auth.uid() resolves for anonymous sessions too
-- (Stash is anonymous-first), so anonymous capture can upload the same way a
-- signed-in user does.
create policy "Users can upload their own bookmark images"
  on storage.objects for insert
  with check (
    bucket_id = 'bookmark-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can update their own bookmark images"
  on storage.objects for update
  using (
    bucket_id = 'bookmark-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'bookmark-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "Users can delete their own bookmark images"
  on storage.objects for delete
  using (
    bucket_id = 'bookmark-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Defense in depth for the authenticated read/list surface (e.g.
-- /storage/v1/object/authenticated/..., or a future listing call). The
-- bucket's `public` flag above independently makes
-- /storage/v1/object/public/... readable with no auth at all — that is the
-- deliberate product choice this policy does not affect either way.
create policy "Users can read their own bookmark images"
  on storage.objects for select
  using (
    bucket_id = 'bookmark-images'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
