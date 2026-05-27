-- Driving-distance metadata for jobs + per-profile home origin.
--
-- Adds two pieces:
--   1. jobs.distance_km / distance_method — populated by the worker once the
--      job has been resolved through the pipeline, alongside the profile's
--      home coordinates. Method is 'driving' when OSRM returned a route, or
--      'haversine' when we had to fall back to a straight-line approximation.
--      NULL = couldn't geocode the job's location string.
--   2. search_profiles.home_address / home_lat / home_lng — the address the
--      user wants distances measured from. The string is what they typed;
--      lat/lng are filled lazily by the worker on the next run (geocoded via
--      Nominatim, country-biased to AU).
--
-- Free-tier only: Nominatim + OSRM public demo. No paid APIs anywhere.

alter table public.jobs
  add column if not exists distance_km numeric(8,2),
  add column if not exists distance_method text
    check (distance_method in ('driving', 'haversine'));

comment on column public.jobs.distance_km is
  'Driving distance from the profile''s home_address in km. NULL if the job location could not be geocoded or the profile has no home address.';
comment on column public.jobs.distance_method is
  '''driving'' = OSRM route. ''haversine'' = straight-line fallback when OSRM returned no route.';

alter table public.search_profiles
  add column if not exists home_address text,
  add column if not exists home_lat numeric(9,6),
  add column if not exists home_lng numeric(9,6);

comment on column public.search_profiles.home_address is
  'User''s free-text home/work address. Distances from this point are shown on the job board. Leave empty to hide distance UI for this profile.';
comment on column public.search_profiles.home_lat is
  'Latitude of home_address, geocoded by the worker via Nominatim. Reset to NULL when home_address changes so the worker re-geocodes.';
comment on column public.search_profiles.home_lng is
  'Longitude of home_address, geocoded by the worker via Nominatim.';
