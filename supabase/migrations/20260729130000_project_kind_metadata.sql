-- Add project kind and metadata for YouTube suggestions / image studio
alter table public.projects
  add column if not exists kind text not null default 'video'
    check (kind in ('video', 'image'));

alter table public.projects
  add column if not exists metadata jsonb not null default '{}'::jsonb;
