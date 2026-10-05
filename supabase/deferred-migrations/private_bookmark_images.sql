-- Deploy a client with ProtectedImage BEFORE applying this migration.
-- Legacy /public/ references remain stable in rows but are signed at render time.
-- Existing objects are preserved; earlier publicly distributed copies and CDN
-- caches cannot be recalled by a database policy change.
update storage.buckets
set public = false,
    allowed_mime_types = array[
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'image/gif', 'image/bmp', 'image/tiff', 'image/avif'
    ]
where id = 'bookmark-images';
