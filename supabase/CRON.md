# Cron Schedule Reference — Britannia Metals Dashboard

All four Edge Functions are scheduled via **pg_cron** on the production database. Credentials are read from Supabase Vault at job-fire time — no secrets are hardcoded in the migration.

---

## The Four Jobs

| Job name              | Function        | Schedule (UTC)    | Plain English                              |
|-----------------------|-----------------|-------------------|--------------------------------------------|
| `ingest-prices-cron`  | ingest-prices   | `0 18 * * 1-5`    | Mon–Fri at 18:00 UTC                       |
| `ingest-news-cron`    | ingest-news     | `0 */2 * * *`     | Every 2 hours, 7 days/week                 |
| `classify-news-cron`  | classify-news   | `15 */2 * * *`    | :15 past every even hour, 7 days/week      |
| `generate-brief-cron` | generate-brief  | `0 6 * * 1-5`     | Mon–Fri at 06:00 UTC (= 07:00 BST summer) |

### Why these schedules?

- **ingest-prices at 18:00 UTC** — LME afternoon kerb closes at ~17:30 UTC. The 30-minute buffer allows settlement prices to propagate through Yahoo Finance and the LME API before ingestion.
- **ingest-news every 2 hours** — Balances freshness against Edge Function cost. Covers Asian pre-market (00:00, 02:00 UTC), European open (06:00, 08:00), and full London day.
- **classify-news 15 min after ingest-news** — Gives the ingest transaction time to commit and become visible before the AI classification pass queries for unclassified rows.
- **generate-brief at 06:00 UTC** — 07:00 BST in summer (UTC+1), 06:00 GMT in winter. Delivers the morning brief before the London pre-market opens at 07:30 BST.

---

## Monitoring

### View all scheduled jobs

```sql
select jobid, jobname, schedule, active
from cron.job
order by jobname;
```

Expected output (all `active = true`):

```
 classify-news-cron    | 15 */2 * * *  | t
 generate-brief-cron   | 0 6 * * 1-5   | t
 ingest-news-cron      | 0 */2 * * *   | t
 ingest-prices-cron    | 0 18 * * 1-5  | t
```

### View recent job run history (pg_cron internal log)

```sql
select jobid, jobname, start_time, end_time, status, return_message
from cron.job_run_details
order by start_time desc
limit 20;
```

### View the cron_log audit table (two rows per fired job)

Each time a job fires, pg_cron inserts a **heartbeat row** immediately, and the Edge Function inserts a **completion row** when it finishes. You will see two rows per successful run.

```sql
select job, status, message, ran_at
from cron_log
order by ran_at desc
limit 20;
```

To distinguish heartbeat rows from completion rows:

```sql
-- Heartbeat rows (inserted by the cron DO block, before the function runs)
select * from cron_log
where message like 'Cron heartbeat:%'
order by ran_at desc;

-- Completion rows (inserted by the Edge Function itself)
select * from cron_log
where message not like 'Cron heartbeat:%'
order by ran_at desc;
```

---

## How to manually unschedule a job

```sql
select cron.unschedule('ingest-prices-cron');
-- or any of:
-- cron.unschedule('ingest-news-cron')
-- cron.unschedule('classify-news-cron')
-- cron.unschedule('generate-brief-cron')
```

To re-enable after unscheduling, re-apply the migration (it is idempotent — it drops and re-creates all four jobs each run):

```bash
supabase db push
```

---

## Debugging a job that isn't firing

Work through these checks in order:

**1. Is the job registered and active?**
```sql
select jobname, active from cron.job where jobname = 'ingest-news-cron';
```
If `active = false`, re-apply the migration.

**2. Is there a heartbeat row in cron_log at the expected time?**
```sql
select * from cron_log
where job = 'ingest-news-cron'
  and message like 'Cron heartbeat:%'
order by ran_at desc
limit 5;
```
- No heartbeat row → pg_cron fired but the DO block errored (Vault access failure, pg_net unavailable). Check `cron.job_run_details` for the error.
- Heartbeat row present → the HTTP request was dispatched. Continue to step 3.

**3. Is there a completion row in cron_log after the heartbeat?**
```sql
select * from cron_log
where job = 'ingest-news'         -- note: Edge Functions write without the '-cron' suffix
  and message not like 'Cron heartbeat:%'
order by ran_at desc
limit 5;
```
- No completion row → the Edge Function was invoked but crashed before writing to cron_log, or the HTTP request was dropped. Check Edge Function logs in the Supabase Dashboard → Edge Functions → Logs.
- Completion row with `status = 'failed'` → the function ran but encountered a fatal error. The `message` column contains the JSON error payload.

**4. Check pg_net request outcomes**
```sql
select id, method, url, status_code, error_msg
from net._http_response
order by created desc
limit 10;
```
This table holds results from outbound HTTP requests made via `net.http_post`. A `status_code` of 200/201 means the function accepted the request.

---

## Schedule change procedure

1. Edit the schedule expression in `supabase/migrations/0002_cron_schedules.sql`
2. Re-apply: `supabase db push`
   The idempotency block at the top of the migration drops and re-creates all four jobs, so re-running is safe.
3. Verify with: `select jobname, schedule from cron.job;`

Do not use `cron.schedule()` interactively in the SQL editor to override a job — the migration will overwrite it on the next push.
