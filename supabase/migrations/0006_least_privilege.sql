-- Least privilege for the client roles
--
-- Supabase grants every privilege on new public-schema tables to anon and
-- authenticated by default, and relies on row level security to hold the line.
-- That works, but it leaves one layer where there should be two: a policy
-- mistake becomes a data loss rather than a denied read.
--
-- This migration removes the privileges no page needs, so a client that somehow
-- got past a policy still could not delete or truncate anything.

-- Start from nothing, then give back only what the site actually calls.
revoke all on hospitals            from anon, authenticated;
revoke all on hospital_staff       from anon, authenticated;
revoke all on hospital_suggestions from anon, authenticated;
revoke all on staff_requests       from anon, authenticated;
revoke all on public_hospitals     from anon, authenticated;

-- The public map. Read only, and row security limits it to published rows.
grant select on public_hospitals to anon, authenticated;
grant select on hospitals        to anon, authenticated;

-- The staff form reads its own hospital and writes the columns allowed by
-- migration 0004. No insert and no delete: creating and removing hospitals is
-- an administrator action.
grant update on hospitals to authenticated;

-- Which hospital a signed-in account may report for. Read only; the row is
-- written by approve_staff_request.
grant select on hospital_staff to authenticated;

-- An applicant files one request and reads back its status. No update, so the
-- status cannot be self-approved.
grant select, insert on staff_requests to authenticated;

-- Anyone may propose a hospital. Nobody may read the table back, because it
-- holds the submitter's contact details, and nobody may edit or remove an
-- existing submission.
grant insert on hospital_suggestions to anon, authenticated;

-- Column privileges from migration 0004 are dropped by the revoke above, so
-- reapply them. Without this, a staff account could write any column on its own
-- hospital, including the coordinates.
revoke update on hospitals from authenticated;
grant update (
  emergency_beds, icu_beds, general_beds,
  oxygen_available, ambulance_available, updated_by,
  main_phone, address, region_area, type, notes
) on hospitals to authenticated;

-- Review views stay with the administrator in the SQL editor.
revoke all on pending_staff_requests       from anon, authenticated;
revoke all on pending_hospital_suggestions from anon, authenticated;
