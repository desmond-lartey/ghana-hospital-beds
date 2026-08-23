-- Staff access requests
--
-- Hospital staff create their own account, state which hospital they work at,
-- and wait for an administrator to approve them. Approval is what writes the
-- row in hospital_staff, and that row is the only thing the update policy on
-- hospitals consults.
--
-- An unapproved account is therefore harmless: it can sign in, and it can do
-- nothing else. No hospital appears in its list and no update passes the policy.

create table staff_requests (
  id           uuid primary key default gen_random_uuid(),

  user_id      uuid not null references auth.users (id) on delete cascade,
  hospital_id  uuid not null references hospitals (id)  on delete cascade,

  full_name    text not null,
  job_title    text,
  work_phone   text,
  -- Whatever the applicant offers to show they work there: a staff number, a
  -- department, a supervisor's name. Free text, because what is available
  -- differs between a teaching hospital and a small polyclinic.
  evidence     text,

  status       text not null default 'pending'
               check (status in ('pending', 'approved', 'rejected')),
  reviewed_at  timestamptz,
  review_note  text,

  created_at   timestamptz not null default now(),

  -- One outstanding request per person per hospital.
  unique (user_id, hospital_id)
);

create index staff_requests_status_idx on staff_requests (status);

alter table staff_requests enable row level security;

-- A signed-in user may file a request, but only in their own name. Writing
-- someone else's user_id is refused by the check.
create policy "users file their own request"
  on staff_requests for insert
  to authenticated
  with check (user_id = auth.uid());

-- An applicant can see their own request, so the sign-in page can tell them
-- whether they are waiting, approved, or turned down. They cannot see anyone
-- else's, and they cannot alter their own status.
create policy "users read their own request"
  on staff_requests for select
  to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------------ approval

-- Approving is two writes that must not come apart: grant the access, then
-- record that it was granted. A function keeps them in one transaction.
--
-- security definer lets this run with the owner's rights, so it works from the
-- SQL editor without loosening any policy. It is not exposed to the anonymous
-- or authenticated roles, so an applicant cannot call it on their own request.
create or replace function approve_staff_request(request_id uuid, note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req staff_requests%rowtype;
begin
  select * into req from staff_requests where id = request_id;

  if not found then
    raise exception 'No staff request with id %', request_id;
  end if;

  if req.status = 'approved' then
    raise notice 'Request % is already approved', request_id;
    return;
  end if;

  insert into hospital_staff (user_id, hospital_id)
  values (req.user_id, req.hospital_id)
  on conflict (user_id, hospital_id) do nothing;

  update staff_requests
     set status = 'approved',
         reviewed_at = now(),
         review_note = note
   where id = request_id;
end;
$$;

revoke execute on function approve_staff_request(uuid, text) from anon, authenticated;

create or replace function reject_staff_request(request_id uuid, note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff_requests
     set status = 'rejected',
         reviewed_at = now(),
         review_note = note
   where id = request_id;

  if not found then
    raise exception 'No staff request with id %', request_id;
  end if;
end;
$$;

revoke execute on function reject_staff_request(uuid, text) from anon, authenticated;

-- Pending requests, with the hospital and applicant email joined on, for review.
create view pending_staff_requests as
  select
    r.id,
    r.full_name,
    r.job_title,
    r.work_phone,
    r.evidence,
    u.email,
    h.name as hospital,
    h.region_area,
    r.created_at
  from staff_requests r
  join auth.users u on u.id = r.user_id
  join hospitals   h on h.id = r.hospital_id
  where r.status = 'pending'
  order by r.created_at;
