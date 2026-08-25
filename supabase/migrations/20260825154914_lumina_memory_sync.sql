-- Optional Lumina Code memory replica. The extension remains fully local when
-- these credentials/table are absent.
create table public.lumina_memory_state (
  user_id uuid not null default auth.uid(),
  namespace text not null default 'default'
    check (char_length(namespace) between 1 and 120),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (user_id, namespace)
);

alter table public.lumina_memory_state enable row level security;

-- Supabase projects created after the 2026 Data API exposure change may not
-- grant new tables automatically. Keep anonymous access revoked and expose
-- only the operations required by the authenticated desktop client.
revoke all on table public.lumina_memory_state from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete
  on table public.lumina_memory_state to authenticated;

create policy "lumina_memory_select_own"
on public.lumina_memory_state
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "lumina_memory_insert_own"
on public.lumina_memory_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "lumina_memory_update_own"
on public.lumina_memory_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "lumina_memory_delete_own"
on public.lumina_memory_state
for delete
to authenticated
using ((select auth.uid()) = user_id);
