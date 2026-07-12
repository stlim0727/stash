-- Enable Realtime Broadcast RLS policies on the realtime.messages table for sync:private:* channels.
-- Allows authenticated users to send/receive sync nudges on their own user-scoped channel.

drop policy if exists "authenticated can receive own sync broadcast" on realtime.messages;
drop policy if exists "authenticated can send own sync broadcast" on realtime.messages;

create policy "authenticated can receive own sync broadcast"
on realtime.messages
for select
to authenticated
using (
  realtime.topic() = 'sync:private:' || auth.uid()::text
  and realtime.messages.extension = 'broadcast'
  and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

create policy "authenticated can send own sync broadcast"
on realtime.messages
for insert
to authenticated
with check (
  realtime.topic() = 'sync:private:' || auth.uid()::text
  and realtime.messages.extension = 'broadcast'
  and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);
