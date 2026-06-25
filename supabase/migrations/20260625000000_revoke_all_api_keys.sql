-- Revoke all outstanding API keys.
--
-- The in-app API-key management UI (create / list / revoke) has been removed,
-- so there is no longer any way for a user to revoke a key from within Stash.
-- Rather than leave still-valid keys that can no longer be managed in-product,
-- revoke every key that is still active. The public-api edge function
-- authenticates with `...&revoked_at=is.null...`, so this immediately stops all
-- existing keys from validating. New keys can no longer be issued from the app.
update public.api_keys
set revoked_at = now()
where revoked_at is null;
