create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

create schema if not exists gold_private;
revoke all on schema gold_private from public, anon, authenticated;

create table gold_private.scan_state (
  singleton boolean primary key default true check (singleton),
  snapshot jsonb,
  token uuid,
  requested_at timestamptz,
  scheduled_slot timestamptz,
  manual_day date,
  manual_count integer not null default 0
);
alter table gold_private.scan_state enable row level security;
insert into gold_private.scan_state default values;

create function public.gold_prices()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select snapshot from gold_private.scan_state where singleton;
$$;

create function gold_private.enqueue_scan(manual boolean)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  state gold_private.scan_state%rowtype;
  now_at timestamptz := clock_timestamp();
  local_at timestamp := now_at at time zone 'Asia/Ho_Chi_Minh';
  slot timestamptz := date_bin('5 minutes', now_at, timestamptz '2000-01-01 00:00:00+00');
  scan_token uuid := gen_random_uuid();
  target text;
  scan_secret text;
  gateway_jwt text;
begin
  if not manual and (local_at::time < time '08:30' or local_at::time >= time '20:31') then
    return '{"outcome":"outside_window"}'::jsonb;
  end if;

  select * into strict state from gold_private.scan_state where singleton for update;
  if not manual and state.scheduled_slot >= slot then return '{"outcome":"duplicate"}'::jsonb; end if;
  if state.requested_at > now_at - interval '1 minute' then
    if not manual then
      update gold_private.scan_state set scheduled_slot = slot where singleton;
    end if;
    return jsonb_build_object('outcome', 'cooldown', 'requestedAt', state.requested_at);
  end if;
  if manual and state.manual_day = local_at::date and state.manual_count >= 100 then
    return '{"outcome":"daily_limit"}'::jsonb;
  end if;

  select decrypted_secret into strict target from vault.decrypted_secrets where name = 'gold_scan_url';
  select decrypted_secret into strict scan_secret from vault.decrypted_secrets where name = 'gold_scan_secret';
  select decrypted_secret into gateway_jwt from vault.decrypted_secrets where name = 'gold_scan_gateway_jwt';
  if target !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/gold-scan$'
     or target is null or scan_secret is null or length(scan_secret) < 32 then
    raise exception 'Invalid gold scanner configuration';
  end if;

  update gold_private.scan_state set
    token = scan_token,
    requested_at = now_at,
    scheduled_slot = case when manual then state.scheduled_slot else slot end,
    manual_day = case when manual then local_at::date else state.manual_day end,
    manual_count = case
      when not manual then state.manual_count
      when state.manual_day = local_at::date then state.manual_count + 1
      else 1
    end
  where singleton;

  perform net.http_post(
    url := target,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Gold-Scan-Secret', scan_secret)
      || case when gateway_jwt is null then '{}'::jsonb
         else jsonb_build_object('Authorization', 'Bearer ' || gateway_jwt) end,
    body := jsonb_build_object('token', scan_token),
    timeout_milliseconds := 50000
  );
  return jsonb_build_object('outcome', 'queued', 'requestedAt', now_at);
end;
$$;

create function public.gold_refresh()
returns jsonb
language sql security definer set search_path = ''
as $$
  select gold_private.enqueue_scan(true);
$$;

create function public.gold_scan_context(scan_token uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('snapshot', snapshot)
  from gold_private.scan_state
  where singleton and token = scan_token and requested_at > statement_timestamp() - interval '1 minute';
$$;

create function public.gold_publish(scan_token uuid, new_snapshot jsonb)
returns boolean
language sql security definer set search_path = ''
as $$
  with saved as (
    update gold_private.scan_state set snapshot = new_snapshot, token = null
    where singleton and token = scan_token and requested_at > statement_timestamp() - interval '1 minute'
    returning 1
  )
  select exists (select from saved);
$$;

revoke execute on function gold_private.enqueue_scan(boolean) from public, anon, authenticated, service_role;
revoke execute on function public.gold_scan_context(uuid), public.gold_publish(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.gold_prices(), public.gold_refresh() from public, anon, authenticated;
grant execute on function public.gold_scan_context(uuid), public.gold_publish(uuid, jsonb) to service_role;
grant execute on function public.gold_prices(), public.gold_refresh() to anon;
