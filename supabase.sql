-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query -> Run).

create table if not exists public.runs (
  id               bigserial primary key,
  created_at       timestamptz not null default now(),
  mode             text not null check (mode in ('ghost', 'live')),
  round            bigint not null,
  nickname         text not null,
  device_id        text not null,
  player_m         real not null,
  steps            integer not null,
  duration_s       integer not null,
  hamster_work     bigint not null,
  hamster_m        real not null,
  margin_m         real not null,
  circumference_mm real not null,
  flagged          boolean not null default false,
  flag_reasons     text[] not null default '{}',
  asleep           boolean not null default false,
  unique (device_id, mode, round)
);

create index if not exists runs_board on public.runs (mode, created_at desc, margin_m desc)
  where flagged = false and asleep = false;

create table if not exists public.calibration_samples (
  id               bigserial primary key,
  created_at       timestamptz not null default now(),
  circumference_mm real not null
);

-- Only the server (service role key) reads and writes these tables.
alter table public.runs enable row level security;
alter table public.calibration_samples enable row level security;
