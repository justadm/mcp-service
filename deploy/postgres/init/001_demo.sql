-- Demo dataset for Postgres connector (MVP).

create table if not exists public.users (
  id bigserial primary key,
  email text not null unique,
  name text not null,
  city text,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  status text not null,
  amount_cents integer not null,
  created_at timestamptz not null default now()
);

-- Идемпотентное расширение схемы (без миграций).
alter table public.users
  add column if not exists is_active boolean not null default true,
  add column if not exists age integer,
  add column if not exists referrer text,
  add column if not exists meta jsonb,
  add column if not exists deleted_at timestamptz;

alter table public.orders
  add column if not exists currency text not null default 'EUR',
  add column if not exists is_gift boolean not null default false,
  add column if not exists meta jsonb,
  add column if not exists updated_at timestamptz;

create index if not exists idx_orders_user_created_at on public.orders(user_id, created_at desc);
create index if not exists idx_users_city on public.users(city);

insert into public.users (email, name, city)
values
  ('alice@example.com', 'Alice', 'Berlin'),
  ('bob@example.com', 'Bob', 'Paris'),
  ('charlie@example.com', 'Charlie', 'Berlin'),
  ('dora@example.com', 'Dora', null),
  ('eve@example.com', 'Eve', 'London')
on conflict (email) do nothing;

insert into public.orders (user_id, status, amount_cents)
select u.id, x.status, x.amount_cents
from (
  values
    ('alice@example.com', 'paid', 1299),
    ('alice@example.com', 'paid', 2599),
    ('bob@example.com', 'pending', 499),
    ('charlie@example.com', 'failed', 999),
    ('dora@example.com', 'paid', 0),
    ('eve@example.com', 'refunded', 1999)
) as x(email, status, amount_cents)
join public.users u on u.email = x.email;

-- Заполняем новые поля (если init уже выполнялся раньше).
update public.users
set
  is_active = coalesce(is_active, true),
  age = coalesce(age, case
    when email = 'alice@example.com' then 31
    when email = 'bob@example.com' then 28
    when email = 'charlie@example.com' then 41
    when email = 'dora@example.com' then null
    when email = 'eve@example.com' then 36
    else age
  end),
  referrer = coalesce(referrer, case
    when email = 'alice@example.com' then 'ads'
    when email = 'bob@example.com' then 'organic'
    when email = 'charlie@example.com' then 'partner'
    else null
  end),
  meta = coalesce(meta, case
    when email = 'alice@example.com' then jsonb_build_object('tier','pro','tags', jsonb_build_array('beta','europe'))
    when email = 'bob@example.com' then jsonb_build_object('tier','free')
    when email = 'charlie@example.com' then jsonb_build_object('tier','team','team_size', 5)
    else meta
  end)
where meta is null or age is null or referrer is null;

update public.orders
set
  currency = coalesce(currency, 'EUR'),
  is_gift = coalesce(is_gift, false),
  meta = coalesce(meta, case
    when status = 'paid' then jsonb_build_object('payment', 'card')
    when status = 'pending' then jsonb_build_object('payment', 'bank_transfer')
    when status = 'failed' then jsonb_build_object('reason', 'insufficient_funds')
    when status = 'refunded' then jsonb_build_object('reason', 'user_request')
    else meta
  end),
  updated_at = coalesce(updated_at, created_at)
where meta is null or updated_at is null;
