-- Add target_verticals to search_profiles to filter adapters

alter table public.search_profiles 
  add column target_verticals text[] not null default '{"general", "tech", "healthcare"}';
