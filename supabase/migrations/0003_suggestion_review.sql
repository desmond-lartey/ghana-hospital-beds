-- Hospital suggestion review
--
-- Mirrors the staff request functions: an administrator reviews the submission,
-- then approves or declines it in one call. Publishing copies the suggestion
-- into hospitals and marks the suggestion reviewed, in a single transaction, so
-- the two cannot come apart.

create or replace function approve_hospital_suggestion(
  suggestion_id uuid,
  note          text default null,
  confidence    text default 'unverified'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sug hospital_suggestions%rowtype;
  new_id uuid;
begin
  select * into sug from hospital_suggestions where id = suggestion_id;

  if not found then
    raise exception 'No hospital suggestion with id %', suggestion_id;
  end if;

  if sug.reviewed then
    raise notice 'Suggestion % has already been reviewed', suggestion_id;
    return null;
  end if;

  if confidence not in ('verified', 'approximate', 'unverified') then
    raise exception 'confidence must be verified, approximate or unverified';
  end if;

  -- A facility already on the map should not be added twice under a variant
  -- spelling, so refuse an exact name match and let the reviewer decide.
  if exists (select 1 from hospitals where lower(name) = lower(sug.name)) then
    raise exception 'A hospital named "%" is already listed. Review it by hand.', sug.name;
  end if;

  insert into hospitals (
    name, type, region_area, address, main_phone, location,
    listing_status, location_confidence, hefra_licence, notes
  )
  values (
    sug.name, sug.type, sug.region_area, sug.address, sug.main_phone,
    st_point(sug.longitude, sug.latitude)::geography,
    'published', confidence, sug.hefra_licence,
    'Added from a public suggestion by ' || sug.submitted_by ||
      coalesce('. ' || sug.notes, '')
  )
  returning id into new_id;

  update hospital_suggestions
     set reviewed = true
   where id = suggestion_id;

  -- The note is kept with the suggestion so the decision has a record.
  if note is not null then
    update hospital_suggestions
       set notes = coalesce(notes || ' | ', '') || 'Review: ' || note
     where id = suggestion_id;
  end if;

  return new_id;
end;
$$;

create or replace function reject_hospital_suggestion(
  suggestion_id uuid,
  note          text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update hospital_suggestions
     set reviewed = true,
         notes = coalesce(notes || ' | ', '') || 'Declined' ||
                 coalesce(': ' || note, '')
   where id = suggestion_id;

  if not found then
    raise exception 'No hospital suggestion with id %', suggestion_id;
  end if;
end;
$$;

revoke execute on function approve_hospital_suggestion(uuid, text, text) from anon, authenticated;
revoke execute on function reject_hospital_suggestion(uuid, text)        from anon, authenticated;

-- Suggestions awaiting a decision.
create or replace view pending_hospital_suggestions as
  select
    id, name, type, region_area, address, main_phone, hefra_licence,
    latitude, longitude,
    submitted_by, contact, relationship, notes,
    created_at
  from hospital_suggestions
  where reviewed = false
  order by created_at;
