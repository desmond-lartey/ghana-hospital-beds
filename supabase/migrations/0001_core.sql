-- Accra Hospital Bed Availability: core schema
--
-- Three tables:
--   hospitals            the published map data, readable by anyone
--   hospital_staff       which account may report for which hospital
--   hospital_suggestions submissions from the public, held for review
--
-- Row level security carries the access rules, so the browser can talk to
-- PostgREST directly with the anonymous key and no server of our own.

create extension if not exists postgis;

-- ---------------------------------------------------------------- hospitals

create table hospitals (
  id                  uuid primary key default gen_random_uuid(),

  name                text not null,
  type                text,
  region_area         text,
  address             text,
  main_phone          text,

  location            geography(Point, 4326) not null,

  emergency_beds      integer check (emergency_beds >= 0),
  icu_beds            integer check (icu_beds     >= 0),
  general_beds        integer check (general_beds >= 0),
  oxygen_available    boolean,
  ambulance_available boolean,

  -- Status is derived, never written. Keeping the thresholds here makes the
  -- database the single source of truth: a client cannot report counts that
  -- disagree with the colour shown on the map.
  status text generated always as (
    case
      when emergency_beds is null
        or icu_beds is null
        or general_beds is null      then 'unreported'
      when emergency_beds = 0
        or icu_beds = 0
        or general_beds = 0          then 'full'
      when emergency_beds <= 3
        or icu_beds <= 2
        or general_beds <= 5         then 'limited'
      else                                'available'
    end
  ) stored,

  last_updated        timestamptz,
  updated_by          text,
  notes               text,

  -- Nothing reaches the public map until an administrator publishes it.
  listing_status      text not null default 'pending_review'
                      check (listing_status in ('pending_review', 'published', 'rejected')),

  -- 'approximate' means the pin has not been checked on the ground. The map
  -- warns on these, because a wrong coordinate sends an ambulance to the wrong
  -- place, which is worse than showing no pin at all.
  location_confidence text not null default 'unverified'
                      check (location_confidence in ('verified', 'approximate', 'unverified')),

  hefra_licence       text,
  created_at          timestamptz not null default now()
);

create index hospitals_location_idx      on hospitals using gist (location);
create index hospitals_listing_state_idx on hospitals (listing_status);

-- ------------------------------------------------------------ staff mapping

create table hospital_staff (
  user_id     uuid not null references auth.users (id) on delete cascade,
  hospital_id uuid not null references hospitals (id)  on delete cascade,
  role        text not null default 'reporter' check (role in ('reporter', 'manager')),
  created_at  timestamptz not null default now(),
  primary key (user_id, hospital_id)
);

create index hospital_staff_user_idx on hospital_staff (user_id);

-- --------------------------------------------------------------- suggestions

-- Kept apart from hospitals so that an anonymous submission can never appear
-- on the map, and so submitter contact details are not publicly readable.
create table hospital_suggestions (
  id             uuid primary key default gen_random_uuid(),

  name           text not null,
  type           text,
  region_area    text,
  address        text,
  main_phone     text,
  hefra_licence  text,

  latitude       double precision not null check (latitude  between 5.3 and 6.0),
  longitude      double precision not null check (longitude between -0.6 and 0.3),

  submitted_by   text not null,
  contact        text not null,
  relationship   text,
  notes          text,

  reviewed       boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ------------------------------------------------------- row level security

alter table hospitals            enable row level security;
alter table hospital_staff       enable row level security;
alter table hospital_suggestions enable row level security;

-- Anyone, signed in or not, may read a published hospital. This is the
-- life-critical read path and must not depend on having an account.
create policy "published hospitals are public"
  on hospitals for select
  using (listing_status = 'published');

-- A staff account may update only the hospital it is attached to.
create policy "staff update own hospital"
  on hospitals for update
  using (
    id in (select hospital_id from hospital_staff where user_id = auth.uid())
  )
  with check (
    id in (select hospital_id from hospital_staff where user_id = auth.uid())
  );

-- A staff member can see their own assignment, and nobody else's.
create policy "staff read own assignment"
  on hospital_staff for select
  using (user_id = auth.uid());

-- Anyone may submit a suggestion. Nobody may read them back: they hold the
-- submitter's contact details, and review happens in the Supabase dashboard.
create policy "anyone may suggest a hospital"
  on hospital_suggestions for insert
  with check (true);

-- ------------------------------------------------------------------ helpers

-- Stamp the report time server-side so a client cannot backdate or postdate it.
create or replace function set_last_updated()
returns trigger
language plpgsql
as $$
begin
  if new.emergency_beds is distinct from old.emergency_beds
     or new.icu_beds is distinct from old.icu_beds
     or new.general_beds is distinct from old.general_beds
     or new.oxygen_available is distinct from old.oxygen_available
     or new.ambulance_available is distinct from old.ambulance_available
  then
    new.last_updated := now();
  end if;
  return new;
end;
$$;

create trigger hospitals_stamp_last_updated
  before update on hospitals
  for each row execute function set_last_updated();

-- A published hospital, as GeoJSON-shaped rows the map can consume directly.
create view public_hospitals as
  select
    id, name, type, region_area, address, main_phone,
    st_y(location::geometry) as latitude,
    st_x(location::geometry) as longitude,
    emergency_beds, icu_beds, general_beds,
    oxygen_available, ambulance_available,
    status, last_updated, updated_by, notes,
    location_confidence
  from hospitals
  where listing_status = 'published';
