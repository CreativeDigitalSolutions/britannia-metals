-- =============================================================================
-- Migration : 0003_reschedule_ingest_prices.sql
-- Date      : 2026-04-30
-- Purpose   : Reschedule ingest-prices-cron from weekday-only 18:00 UTC to
--             every 30 minutes, 7 days/week.
--
-- Root cause investigation (Session M):
--   cron.job showed ingest-prices-cron as active with schedule 0 18 * * 1-5.
--   cron.job_run_details showed zero executions for this job specifically.
--   Command SQL and vault secret references were verified identical to the
--   working ingest-news-cron and classify-news-cron jobs.
--   Vault secrets 'project_url' and 'service_role_key' both exist.
--
--   Conclusion: no code or config bug. The migration (0002) was applied on
--   Tuesday 2026-04-29 AFTER 18:00 UTC (first cron.job_run_details entry is
--   at 20:00:00 UTC that day). The 0 18 * * 1-5 schedule therefore has its
--   first post-registration fire time at Wednesday 2026-04-30 18:00 UTC —
--   still ~14 hours in the future at investigation time. The job would have
--   fired correctly on its own schedule; this reschedule to */30 * * * *
--   (a) gives near-immediate verification and (b) keeps the prices table
--   fresh throughout the day for the live dashboard.
--
-- Author    : Claude Code (Session M – final polish + deploy, Wave 4)
-- =============================================================================

-- Drop and re-register ingest-prices-cron with a 30-minute schedule.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'ingest-prices-cron') then
    perform cron.unschedule('ingest-prices-cron');
  end if;
end $$;

select cron.schedule(
  'ingest-prices-cron',
  '*/30 * * * *',
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

-- Verification: confirm the new schedule is registered
-- select jobname, schedule, active from cron.job where jobname = 'ingest-prices-cron';
-- Expected: ingest-prices-cron | */30 * * * * | t
