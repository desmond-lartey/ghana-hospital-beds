-- Security advisor: rls_disabled_in_public
--
-- Context before you run anything.
--
-- Every table this project creates already has row level security enabled:
-- hospitals, hospital_staff and hospital_suggestions in migration 0001, and
-- staff_requests in migration 0002. Migration 0006 then removed the privileges
-- no page needs, so anon cannot delete or truncate any of them.
--
-- So the table the advisor is naming is almost certainly one this project did
-- not create. The usual cause is PostGIS. Migration 0001 opens with
--
--     create extension if not exists postgis;
--
-- and with no schema named, that installs into public. PostGIS brings its own
-- table with it, spatial_ref_sys, which holds the EPSG coordinate system
-- definitions. It is owned by the extension, it has no row security, and it
-- sits in the schema PostgREST exposes. The advisor sees a public table with
-- RLS off and reports it, which is correct as far as it goes.
--
-- The severity is lower than the email suggests, for this particular table.
-- PostGIS grants only SELECT on spatial_ref_sys, so "read, edit and delete"
-- overstates it: nobody can write to it through your API. What is true is that
-- it should not be reachable from the anon key at all, because nothing on your
-- site queries it.
--
-- Do not run this file top to bottom. Run step 1, read what it tells you, then
-- apply the part of step 2 that matches what you actually have.


-- ============================================================== step 1 =====
-- Ask the database which tables in public are missing row level security.
-- Run this on its own and read the result.

select
  c.relname                    as table_name,
  c.relrowsecurity             as rls_enabled,
  pg_get_userbyid(c.relowner)  as owner
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relrowsecurity, c.relname;

-- Expected: hospitals, hospital_staff, hospital_suggestions and staff_requests
-- all show rls_enabled = true. Anything showing false is what the advisor is
-- complaining about.


-- ============================================================== step 2a ====
-- If the answer was spatial_ref_sys.
--
-- Enabling row security on it will not work:
--
--     alter table public.spatial_ref_sys enable row level security;
--     ERROR:  must be owner of table spatial_ref_sys
--
-- It belongs to the extension, not to you. Take the access away instead. This
-- is the fix Supabase recommends for extension-owned tables, and it closes the
-- actual exposure rather than the symptom.

revoke all on public.spatial_ref_sys from anon, authenticated;

-- Safe for this project: nothing here reads spatial_ref_sys. The functions the
-- site uses are st_point, st_x and st_y, none of which consult it. Only
-- st_transform does, and no query in this project transforms between
-- coordinate systems.
--
-- The advisor may keep listing spatial_ref_sys after this, because the table
-- still has RLS off. If you want it to go quiet permanently, PostGIS has to
-- live somewhere other than public, and moving an installed PostGIS is a
-- bigger job than it looks: every geography column, index and function
-- reference has to keep resolving. Not worth it for a table of EPSG codes that
-- your API can no longer reach.


-- ============================================================== step 2b ====
-- If the answer was a table you created by hand in the dashboard.
--
-- The Table Editor creates tables with RLS off unless you tick the box, and
-- Supabase grants anon and authenticated full privileges on new public tables
-- by default. That combination is the genuinely dangerous one: readable,
-- writable and deletable by anyone holding the anon key, which is printed in
-- config.js on every page load.
--
-- Uncomment and substitute the real name. Enabling RLS with no policies denies
-- everything, which is the right default: open it back up one policy at a
-- time, only for what a page actually needs.

-- alter table public.your_table_name enable row level security;
-- revoke all on public.your_table_name from anon, authenticated;

-- If that table holds anything you typed in while testing, check what is in it
-- before you assume nothing was reached. Data written through the anon key
-- leaves no trace of who wrote it.


-- ============================================================== step 3 =====
-- Related hardening, worth doing regardless of what step 1 said.
--
-- The advisor's second finding, auth_users_exposed, was raised against your
-- other project rather than this one. This project has the same shape of view
-- though: pending_staff_requests joins auth.users to show an applicant's email
-- for review. Migration 0005 revoked it from anon and authenticated, so it is
-- not reachable through the API today, and that is why it was not flagged.
--
-- That protection rests on a revoke staying in place. A view created before
-- Postgres 15, or without security_invoker, runs with its owner's rights, so
-- if a grant were ever added back the view would return every row regardless
-- of the policies on the underlying tables. Setting security_invoker makes the
-- policies apply through the view, so a future mistaken grant leaks nothing.

alter view pending_staff_requests       set (security_invoker = on);
alter view pending_hospital_suggestions set (security_invoker = on);

-- And restate the revokes, so this file leaves the review views in a known
-- state whatever order earlier migrations ran in.
revoke all on pending_staff_requests       from anon, authenticated;
revoke all on pending_hospital_suggestions from anon, authenticated;


-- ============================================================== step 4 =====
-- Confirm. Re-run step 1, then open Advisors in the sidebar and refresh.
--
-- To check the anon role's reach directly, this lists every table and view in
-- public that anon can still touch, and how:

select
  table_name,
  string_agg(distinct privilege_type, ', ' order by privilege_type) as anon_can
from information_schema.role_table_grants
where grantee = 'anon'
  and table_schema = 'public'
group by table_name
order by table_name;

-- Expected for this project, and nothing else:
--   hospitals             SELECT      (row security limits it to published rows)
--   public_hospitals      SELECT      (the map's read path)
--   hospital_suggestions  INSERT      (write only; suggestions are never read back)
