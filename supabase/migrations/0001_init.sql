-- Easy Apply Autopilot: initial schema
-- Users are created by Supabase Auth (auth.users); public.users mirrors them and
-- holds subscription state, which clients can read but never write.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table public.users (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text,
  subscription_status text not null default 'free'
                      check (subscription_status in ('free', 'pro', 'past_due', 'canceled')),
  created_at          timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique references public.users (id) on delete cascade,
  first_name           text,
  last_name            text,
  email                text,
  phone                text,
  phone_country        text,          -- e.g. "United States (+1)"
  address              text,
  city                 text,
  state                text,
  zip                  text,
  linkedin_url         text,
  website              text,
  years_experience     integer,
  education            text,          -- e.g. "Bachelor's Degree"
  work_authorized      text,          -- "Yes" / "No"
  requires_sponsorship text,          -- "Yes" / "No"
  desired_salary       text,
  notice_period        text,
  cover_letter         text,
  work_history         jsonb not null default '[]'::jsonb,
  skills               jsonb not null default '{}'::jsonb,  -- { "Python": 5, "React": 3 }
  answer_bank          jsonb not null default '{}'::jsonb,  -- { "<normalized question>": { "label": ..., "answer": ... } }
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- applications
-- ---------------------------------------------------------------------------
create table public.applications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.users (id) on delete cascade,
  job_id     text,
  job_title  text,
  company    text,
  job_url    text,
  applied_at timestamptz not null default now(),
  status     text not null default 'applied'
             check (status in ('applied', 'interviewing', 'offer', 'rejected', 'withdrawn')),
  unique (user_id, job_id)
);

create index applications_user_applied_at_idx on public.applications (user_id, applied_at desc);

-- Free tier: tracker holds at most 10 applications. Enforced here so it can't be
-- bypassed by editing the extension.
create function public.enforce_tracker_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  plan  text;
  total integer;
begin
  select subscription_status into plan from public.users where id = new.user_id;
  if coalesce(plan, 'free') <> 'pro' then
    select count(*) into total from public.applications where user_id = new.user_id;
    if total >= 10 then
      raise exception 'FREE_TIER_LIMIT' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger applications_tracker_limit
  before insert on public.applications
  for each row execute function public.enforce_tracker_limit();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.users        enable row level security;
alter table public.profiles     enable row level security;
alter table public.applications enable row level security;

-- users: read own row only. No insert/update policies: subscription_status is
-- changed only by the service role (future Stripe webhook).
create policy "users read own" on public.users
  for select using (id = auth.uid());

create policy "profiles select own" on public.profiles
  for select using (user_id = auth.uid());
create policy "profiles insert own" on public.profiles
  for insert with check (user_id = auth.uid());
create policy "profiles update own" on public.profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "applications select own" on public.applications
  for select using (user_id = auth.uid());
create policy "applications insert own" on public.applications
  for insert with check (user_id = auth.uid());
create policy "applications update own" on public.applications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "applications delete own" on public.applications
  for delete using (user_id = auth.uid());

-- TODO(stripe): a server-side webhook (Railway, or a Supabase Edge Function) using
-- the service role key sets users.subscription_status = 'pro' / 'canceled' on
-- checkout.session.completed / customer.subscription.deleted.
