alter table public.search_profiles
  add column if not exists adzuna_title_keywords text default '',
  add column if not exists adzuna_exact_phrase text default '',
  add column if not exists adzuna_any_keywords text default '',
  add column if not exists adzuna_exclude_keywords text default '',
  add column if not exists adzuna_salary_min int default null,
  add column if not exists adzuna_salary_max int default null,
  add column if not exists adzuna_contract_type text default null check (adzuna_contract_type in ('permanent', 'contract', null)),
  add column if not exists adzuna_hours text default null check (adzuna_hours in ('full_time', 'part_time', null)),
  add column if not exists adzuna_distance_km int default 25,
  add column if not exists adzuna_max_days_old int default 14,
  add column if not exists exclude_title_keywords text[] default '{}';
