-- JokStream: per-channel ephemeral live chat
-- Run this entire script in Supabase SQL Editor.
-- Requires pg_cron to be available/enabled for the scheduled cleanup section.

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.channel_messages (
  id uuid primary key default gen_random_uuid(),
  channel_id text not null,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 24),
  content text not null check (char_length(btrim(content)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists channel_messages_channel_created_idx
  on public.channel_messages (channel_id, created_at desc);

alter table public.channel_messages enable row level security;

-- Guests may read only the public chat messages; no user account is required.
drop policy if exists "Anyone can read channel chat" on public.channel_messages;
create policy "Anyone can read channel chat"
  on public.channel_messages for select
  to anon, authenticated
  using (created_at > now() - interval '15 minutes');

-- Guest posting is intentionally enabled; constraints limit nickname/message sizes.
drop policy if exists "Guests can post channel chat" on public.channel_messages;
create policy "Guests can post channel chat"
  on public.channel_messages for insert
  to anon, authenticated
  with check (
    char_length(btrim(nickname)) between 1 and 24
    and char_length(btrim(content)) between 1 and 500
    and created_at >= now() - interval '1 minute'
    and created_at <= now() + interval '1 minute'
  );

grant select, insert on public.channel_messages to anon, authenticated;

-- Enable Postgres Changes for this table (safe to run repeatedly).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'channel_messages'
  ) then
    alter publication supabase_realtime add table public.channel_messages;
  end if;
end
$$;

-- Remove expired rows every 10 minutes (15-minute retention).
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'jokstream-channel-chat-cleanup') then
    perform cron.schedule(
      'jokstream-channel-chat-cleanup',
      '*/10 * * * *',
      $job$delete from public.channel_messages where created_at < now() - interval '15 minutes';$job$
    );
  end if;
end
$$;
