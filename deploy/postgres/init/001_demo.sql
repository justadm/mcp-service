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

insert into public.users (email, name, city)
values
  ('alice@example.com', 'Alice', 'Berlin'),
  ('bob@example.com', 'Bob', 'Paris'),
  ('charlie@example.com', 'Charlie', 'Berlin')
on conflict (email) do nothing;

insert into public.orders (user_id, status, amount_cents)
select u.id, x.status, x.amount_cents
from (
  values
    ('alice@example.com', 'paid', 1299),
    ('alice@example.com', 'paid', 2599),
    ('bob@example.com', 'pending', 499),
    ('charlie@example.com', 'failed', 999)
) as x(email, status, amount_cents)
join public.users u on u.email = x.email;

