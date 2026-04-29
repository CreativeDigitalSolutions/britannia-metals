-- =============================================================================
-- Migration : 0001_initial_schema.sql
-- Date      : 2026-04-24
-- Purpose   : Bootstrap all tables, extensions, indexes, and RLS policies for
--             the Britannia Metals broker dashboard data layer.
-- Author    : Claude Code (session A – Supabase data layer stream)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_cron;    -- scheduled jobs
create extension if not exists pg_net;     -- outbound HTTP from SQL / cron

-- ---------------------------------------------------------------------------
-- TABLE: prices
-- One row per metal × source × contract × trading day.
-- Written by: Edge Function ingest-prices
-- ---------------------------------------------------------------------------
create table if not exists public.prices (
  id           uuid        primary key default gen_random_uuid(),
  metal        text        not null check (metal in ('copper','aluminium','zinc','nickel','lead','tin','gold','silver')),
  source       text        not null check (source in ('lme_official','yahoo','yahoo_fallback')),
  contract     text        not null check (contract in ('cash','3m','front_month')),
  price        numeric     not null,
  currency     text        not null default 'USD',
  unit         text        not null default 'tonne' check (unit in ('tonne','troy_oz','lb')),
  as_of        timestamptz not null,
  prev_close   numeric,
  change_pct   numeric,
  created_at   timestamptz default now(),
  unique (metal, source, contract, as_of)
);

-- ---------------------------------------------------------------------------
-- TABLE: lme_stocks
-- Daily LME warehouse stock levels per metal.
-- Written by: Edge Function ingest-prices
-- ---------------------------------------------------------------------------
create table if not exists public.lme_stocks (
  id                  uuid    primary key default gen_random_uuid(),
  metal               text    not null,
  on_warrant          bigint,
  cancelled_warrants  bigint,
  total_stock         bigint,
  cancelled_pct       numeric generated always as (
                        case
                          when total_stock > 0
                          then (cancelled_warrants::numeric / total_stock) * 100
                          else 0
                        end
                      ) stored,
  as_of               date    not null,
  created_at          timestamptz default now(),
  unique (metal, as_of)
);

-- ---------------------------------------------------------------------------
-- TABLE: news
-- Aggregated headlines from RSS / scraper feeds.
-- Written by: Edge Function ingest-news; sentiment fields by classify-news
-- ---------------------------------------------------------------------------
create table if not exists public.news (
  id                   uuid        primary key default gen_random_uuid(),
  source               text        not null,
  headline             text        not null,
  url                  text        not null unique,
  summary              text,
  published_at         timestamptz not null,
  metals               text[],                -- AI-populated by classify-news
  sentiment            text        check (sentiment in ('bullish','bearish','neutral')),
  sentiment_rationale  text,
  relevant             boolean,               -- null until classified
  created_at           timestamptz default now()
);

-- news indexes
create index if not exists news_published_at_idx
  on public.news (published_at desc);

create index if not exists news_relevant_idx
  on public.news (published_at desc)
  where relevant = true;

-- ---------------------------------------------------------------------------
-- TABLE: briefs
-- Daily AI-generated morning briefs.
-- Written by: Edge Function generate-brief
-- ---------------------------------------------------------------------------
create table if not exists public.briefs (
  id            uuid        primary key default gen_random_uuid(),
  content       text        not null,
  generated_at  timestamptz not null default now(),
  for_date      date        not null unique
);

-- ---------------------------------------------------------------------------
-- TABLE: arb_history
-- Daily LME-COMEX copper spread.
-- Written by: Edge Function ingest-prices
-- ---------------------------------------------------------------------------
create table if not exists public.arb_history (
  id                    uuid    primary key default gen_random_uuid(),
  as_of                 date    not null unique,
  lme_copper_usd_tonne  numeric not null,
  comex_copper_usd_tonne numeric not null,
  spread_usd            numeric generated always as (comex_copper_usd_tonne - lme_copper_usd_tonne) stored,
  spread_pct            numeric generated always as (
                          ((comex_copper_usd_tonne - lme_copper_usd_tonne) / lme_copper_usd_tonne) * 100
                        ) stored
);

-- ---------------------------------------------------------------------------
-- TABLE: cron_log
-- Audit trail for scheduled cron jobs.
-- Written by: all Edge Functions at end of each run
-- ---------------------------------------------------------------------------
create table if not exists public.cron_log (
  id        uuid        primary key default gen_random_uuid(),
  job       text        not null,
  status    text        not null check (status in ('success','partial','failed')),
  message   text,
  ran_at    timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Policy: anon (frontend) can SELECT; writes only via service_role (no RLS bypass needed
-- because service_role bypasses RLS by default in Supabase).
-- ---------------------------------------------------------------------------

-- prices
alter table public.prices enable row level security;
create policy "public can read prices"
  on public.prices for select
  using (true);

-- lme_stocks
alter table public.lme_stocks enable row level security;
create policy "public can read lme_stocks"
  on public.lme_stocks for select
  using (true);

-- news
alter table public.news enable row level security;
create policy "public can read news"
  on public.news for select
  using (true);

-- briefs
alter table public.briefs enable row level security;
create policy "public can read briefs"
  on public.briefs for select
  using (true);

-- arb_history
alter table public.arb_history enable row level security;
create policy "public can read arb_history"
  on public.arb_history for select
  using (true);

-- cron_log
alter table public.cron_log enable row level security;
create policy "public can read cron_log"
  on public.cron_log for select
  using (true);

-- ---------------------------------------------------------------------------
-- Vault secrets (project URL + service role key stored securely in pgsodium)
-- Run after vault extension is confirmed available on the hosted project.
-- ---------------------------------------------------------------------------
-- These are idempotent: if the secret already exists the select returns the
-- existing id without error.
select vault.create_secret(
  'https://tevakneehbiwltboavlw.supabase.co',
  'project_url'
);

select vault.create_secret(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRldmFrbmVlaGJpd2x0Ym9hdmx3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njk4MTAyMCwiZXhwIjoyMDkyNTU3MDIwfQ.zssYua3g8toso0ZX__2ep2Q5ioTr1ge384Z0wKVmN6E',
  'service_role_key'
);
