-- =============================================================================
-- Migration : 0002_cron_schedules.sql
-- Date      : 2026-04-29
-- Purpose   : Schedule all four Edge Functions via pg_cron so the pipeline
--             runs autonomously. Credentials are read from Supabase Vault at
--             job-fire time — never hardcoded here.
-- Author    : Claude Code (Session K – cron scheduling, Wave 4)
-- =============================================================================

-- Ensure required extensions are present (no-op if already enabled in 0001).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Idempotency: unschedule any existing jobs of the same name before
-- re-creating them. cron.unschedule() raises if the job is absent, so we
-- guard each call with an IF EXISTS check.
-- ---------------------------------------------------------------------------
do $$
declare
  job_names text[] := array[
    'ingest-prices-cron',
    'ingest-news-cron',
    'classify-news-cron',
    'generate-brief-cron'
  ];
  jname text;
begin
  foreach jname in array job_names loop
    if exists (select 1 from cron.job where jobname = jname) then
      perform cron.unschedule(jname);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Job 1: ingest-prices
-- Schedule : 0 18 * * 1-5  →  Mon–Fri 18:00 UTC
-- Rationale: LME afternoon kerb closes ~17:30 UTC; 18:00 gives settlement
--            prices time to propagate through Yahoo Finance / LME API.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'ingest-prices-cron',
  '0 18 * * 1-5',
  $cron$
  do $$
  declare
    v_url  text;
    v_key  text;
    v_rid  bigint;
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'project_url';

    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';

    select net.http_post(
      url     := v_url || '/functions/v1/ingest-prices',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := '{}'::jsonb
    ) into v_rid;

    insert into cron_log (job, status, message)
    values (
      'ingest-prices-cron',
      'success',
      'Cron heartbeat: ingest-prices fired (request_id=' || v_rid || ')'
    );
  end $$;
  $cron$
);

-- ---------------------------------------------------------------------------
-- Job 2: ingest-news
-- Schedule : 0 */2 * * *  →  Every 2 hours, 7 days/week (00:00, 02:00, …)
-- Rationale: Keeps the news table fresh throughout the trading day and
--            overnight for Asian/early-European session coverage.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'ingest-news-cron',
  '0 */2 * * *',
  $cron$
  do $$
  declare
    v_url  text;
    v_key  text;
    v_rid  bigint;
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'project_url';

    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';

    select net.http_post(
      url     := v_url || '/functions/v1/ingest-news',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := '{}'::jsonb
    ) into v_rid;

    insert into cron_log (job, status, message)
    values (
      'ingest-news-cron',
      'success',
      'Cron heartbeat: ingest-news fired (request_id=' || v_rid || ')'
    );
  end $$;
  $cron$
);

-- ---------------------------------------------------------------------------
-- Job 3: classify-news
-- Schedule : 15 */2 * * *  →  :15 past every even hour (00:15, 02:15, …)
-- Rationale: Fires 15 minutes after ingest-news so newly ingested rows are
--            committed and available before the AI classification pass runs.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'classify-news-cron',
  '15 */2 * * *',
  $cron$
  do $$
  declare
    v_url  text;
    v_key  text;
    v_rid  bigint;
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'project_url';

    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';

    select net.http_post(
      url     := v_url || '/functions/v1/classify-news',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := '{}'::jsonb
    ) into v_rid;

    insert into cron_log (job, status, message)
    values (
      'classify-news-cron',
      'success',
      'Cron heartbeat: classify-news fired (request_id=' || v_rid || ')'
    );
  end $$;
  $cron$
);

-- ---------------------------------------------------------------------------
-- Job 4: generate-brief
-- Schedule : 0 6 * * 1-5  →  Mon–Fri 06:00 UTC
-- Rationale: 06:00 UTC = 07:00 BST (summer) / 06:00 GMT (winter).
--            Delivers the morning brief before London pre-market opens at
--            07:30 BST, positioned like FT/Economist commodity summaries.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'generate-brief-cron',
  '0 6 * * 1-5',
  $cron$
  do $$
  declare
    v_url  text;
    v_key  text;
    v_rid  bigint;
  begin
    select decrypted_secret into v_url
      from vault.decrypted_secrets where name = 'project_url';

    select decrypted_secret into v_key
      from vault.decrypted_secrets where name = 'service_role_key';

    select net.http_post(
      url     := v_url || '/functions/v1/generate-brief',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body    := '{}'::jsonb
    ) into v_rid;

    insert into cron_log (job, status, message)
    values (
      'generate-brief-cron',
      'success',
      'Cron heartbeat: generate-brief fired (request_id=' || v_rid || ')'
    );
  end $$;
  $cron$
);

-- ---------------------------------------------------------------------------
-- Verification helper (run after applying migration to confirm all four jobs
-- are registered and active):
--
--   select jobname, schedule, active from cron.job order by jobname;
--
-- Expected output:
--   classify-news-cron    | 15 */2 * * *  | t
--   generate-brief-cron   | 0 6 * * 1-5   | t
--   ingest-news-cron      | 0 */2 * * *   | t
--   ingest-prices-cron    | 0 18 * * 1-5  | t
-- ---------------------------------------------------------------------------
