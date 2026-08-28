-- Let the public read the public view
--
-- The map queries public_hospitals with the anonymous key. Row level security
-- was in place from the first migration, but a view still needs its own select
-- privilege, and that was never granted. The effect was quiet rather than loud:
-- the query failed, the page fell back to the file published alongside it, and
-- the only visible sign was "showing last published data" in the header.
--
-- Views are the easy thing to miss here. Enabling row security on a table does
-- not carry across to a view built on it, and PostgREST will not expose a view
-- the requesting role cannot select from.

-- security_invoker makes the view run with the privileges of whoever queries it,
-- so the policies on hospitals still apply through the view rather than being
-- bypassed by the view's owner. Postgres 15 and later.
alter view public_hospitals set (security_invoker = on);

grant select on public_hospitals to anon, authenticated;

-- The staff form reads these directly, so the signed-in role needs them too.
grant select on hospitals      to anon, authenticated;
grant select on hospital_staff to authenticated;

-- An applicant reads their own request to learn whether it is pending, approved
-- or declined, and the landing page reads the name they registered with. The
-- policy from migration 0002 limits both to their own row.
grant select, insert on staff_requests to authenticated;

-- Suggestions stay write-only for the public: anyone may add one, nobody may
-- read them back, because they carry the submitter's contact details.
grant insert on hospital_suggestions to anon, authenticated;

-- The review views are for the administrator in the SQL editor, not for clients.
revoke all on pending_staff_requests      from anon, authenticated;
revoke all on pending_hospital_suggestions from anon, authenticated;
