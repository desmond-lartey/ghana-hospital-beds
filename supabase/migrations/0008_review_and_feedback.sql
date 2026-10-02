-- Map review sessions, anchored notes, and public feedback
--
-- Two features, deliberately kept apart.
--
-- REVIEW SESSIONS are synchronous. Two or more people open the same map from a
-- session code and leave notes anchored to specific hospitals: a pin in the
-- wrong place, a phone number that no longer answers, a facility that has moved.
-- This is the workflow that clears the prerequisites in the README - nineteen of
-- twenty-two coordinates are approximate, and several phone numbers are blank -
-- and it is the reason to get a hospital's records officer on a call.
--
-- FEEDBACK is asynchronous. One message, from anyone, at any time, with nobody
-- required to be present. It is write-only to the public, exactly like
-- hospital_suggestions, because it carries the sender's contact details.
--
-- Neither is an emergency channel. Nothing here is read by anyone on a schedule,
-- and the interface says so rather than implying a staffed desk.
--
-- ---------------------------------------------------------------------------
-- AUTHORISATION MODEL
--
-- A review session is readable and writable by whoever holds its code, with no
-- account. That is the same anonymous, code-gated model GeoLibre uses, and it
-- suits the setting: a hospital records officer should not have to register an
-- account to spend twenty minutes correcting pins.
--
-- Row level security cannot express "only if the caller supplied the right
-- code", because a policy cannot require a client to have filtered. So the
-- client gets no table privileges at all here. Every read and write goes
-- through a security definer function that takes the code and checks it first.
-- Without the code the functions return nothing, and there is no second route
-- to the tables.
--
-- Depends on 0001 through 0007.


-- ============================================================== schema =====

create table if not exists review_sessions (
  id          uuid primary key default gen_random_uuid(),

  -- Unguessable, and short enough to read down a phone line. Eight characters
  -- from a 32-letter alphabet is about 1.1e12 combinations.
  code        text not null unique
              check (code ~ '^[A-Z0-9]{8}$'),

  label       text check (char_length(label) <= 120),
  host_name   text check (char_length(host_name) <= 80),

  created_at  timestamptz not null default now(),

  -- A session is a working meeting, not a permanent record. Notes outlive it in
  -- the table, but the code stops opening after this.
  expires_at  timestamptz not null default now() + interval '30 days',
  closed      boolean not null default false
);

create index if not exists review_sessions_code_idx on review_sessions (code);

create table if not exists review_notes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references review_sessions (id) on delete cascade,

  -- The hospital this note is about, when it is about one. Null for a note
  -- dropped on open ground: a missing facility, or a landmark worth recording.
  hospital_id  uuid references hospitals (id) on delete set null,

  -- Always present, so a note can be drawn on the map whether or not it names a
  -- hospital, and so it survives that hospital being removed.
  latitude     double precision not null check (latitude  between 5.3 and 6.0),
  longitude    double precision not null check (longitude between -0.6 and 0.3),

  -- What kind of correction this is, so a session can be worked through by
  -- category and the result read as a to-do list afterwards.
  kind         text not null default 'other'
               check (kind in ('location', 'phone', 'details', 'missing', 'other')),

  author_name  text not null check (char_length(author_name) between 1 and 80),
  author_color text not null default '#1e3a8f' check (author_color ~ '^#[0-9a-fA-F]{6}$'),

  body         text not null check (char_length(body) between 1 and 2000),

  resolved     boolean not null default false,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists review_notes_session_idx  on review_notes (session_id, created_at);
create index if not exists review_notes_hospital_idx on review_notes (hospital_id);

create table if not exists review_replies (
  id           uuid primary key default gen_random_uuid(),
  note_id      uuid not null references review_notes (id) on delete cascade,
  author_name  text not null check (char_length(author_name) between 1 and 80),
  author_color text not null default '#1e3a8f' check (author_color ~ '^#[0-9a-fA-F]{6}$'),
  body         text not null check (char_length(body) between 1 and 2000),
  created_at   timestamptz not null default now()
);

create index if not exists review_replies_note_idx on review_replies (note_id, created_at);

-- Public feedback. Mirrors hospital_suggestions: anyone may write, nobody may
-- read back, because a message can carry an email address or a phone number.
create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),

  kind        text not null default 'other'
              check (kind in ('data', 'hospital', 'bug', 'idea', 'other')),

  message     text not null check (char_length(message) between 5 and 4000),

  -- Optional. Someone reporting a wrong phone number may not want to be
  -- contacted about it, and should not have to be.
  contact     text check (char_length(contact) <= 200),

  hospital_id uuid references hospitals (id) on delete set null,

  -- Where they were when they sent it, which is most of what a bug report needs.
  page        text check (char_length(page) <= 300),
  user_agent  text check (char_length(user_agent) <= 500),

  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists feedback_unhandled_idx on feedback (created_at) where not handled;


-- =================================================== row level security =====
--
-- Enabled on all four. The three review tables have no policies at all, which
-- denies everything to anon and authenticated: the only route in is the
-- security definer functions below. feedback gets one insert policy and nothing
-- else, so it can be written and never read.

alter table review_sessions enable row level security;
alter table review_notes    enable row level security;
alter table review_replies  enable row level security;
alter table feedback        enable row level security;

drop policy if exists "anyone may send feedback" on feedback;
create policy "anyone may send feedback"
  on feedback for insert
  with check (true);


-- ============================================================== grants =====
--
-- Start from nothing. The review tables stay at nothing; feedback gets insert.

revoke all on review_sessions from anon, authenticated;
revoke all on review_notes    from anon, authenticated;
revoke all on review_replies  from anon, authenticated;
revoke all on feedback        from anon, authenticated;

grant insert on feedback to anon, authenticated;


-- =========================================================== functions =====

-- Session codes avoid I, O, 0 and 1. A code is read aloud and typed by someone
-- who is not looking at the screen it came from, and those four are where that
-- goes wrong.
create or replace function generate_review_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i integer;
begin
  for i in 1..8 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

-- -------------------------------------------------------------- create -----

create or replace function create_review_session(
  p_label     text default null,
  p_host_name text default null
)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_code text;
  tries    integer := 0;
  recent   integer;
begin
  -- Anyone may start a session without an account, so the only thing standing
  -- between this and a filled table is a ceiling. Sessions are cheap and a real
  -- review day might run several, but nobody needs sixty in an hour.
  select count(*) into recent
    from review_sessions
   where created_at > now() - interval '1 hour';

  if recent >= 60 then
    raise exception 'Too many review sessions have been started recently. Try again later.'
      using errcode = 'check_violation';
  end if;

  loop
    tries := tries + 1;
    new_code := generate_review_code();
    exit when not exists (select 1 from review_sessions s where s.code = new_code);
    if tries > 12 then
      raise exception 'Could not allocate a session code.';
    end if;
  end loop;

  return query
  insert into review_sessions (code, label, host_name)
  values (
    new_code,
    nullif(btrim(coalesce(p_label, '')), ''),
    nullif(btrim(coalesce(p_host_name, '')), '')
  )
  returning review_sessions.code, review_sessions.expires_at;
end;
$$;

-- ---------------------------------------------------------------- open -----
--
-- The whole session in one call: the session row, every note, and every reply.
-- A review session holds tens of notes, not thousands, so one round trip is
-- simpler than three and leaves no window where notes and replies disagree.

create or replace function open_review_session(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sess review_sessions%rowtype;
begin
  select * into sess
    from review_sessions
   where code = upper(btrim(p_code));

  if not found then
    raise exception 'No review session with that code.'
      using errcode = 'no_data_found';
  end if;

  if sess.closed or sess.expires_at < now() then
    raise exception 'That review session has ended.'
      using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'code',    sess.code,
    'label',   sess.label,
    'host',    sess.host_name,
    'created', sess.created_at,
    'expires', sess.expires_at,
    'notes',   coalesce((
      select jsonb_agg(note order by note->>'created_at')
      from (
        select jsonb_build_object(
          'id',           n.id,
          'hospital_id',  n.hospital_id,
          'latitude',     n.latitude,
          'longitude',    n.longitude,
          'kind',         n.kind,
          'author_name',  n.author_name,
          'author_color', n.author_color,
          'body',         n.body,
          'resolved',     n.resolved,
          'created_at',   n.created_at,
          'replies',      coalesce((
            select jsonb_agg(jsonb_build_object(
              'id',           r.id,
              'author_name',  r.author_name,
              'author_color', r.author_color,
              'body',         r.body,
              'created_at',   r.created_at
            ) order by r.created_at)
            from review_replies r where r.note_id = n.id
          ), '[]'::jsonb)
        ) as note
        from review_notes n
        where n.session_id = sess.id
      ) notes
    ), '[]'::jsonb)
  );
end;
$$;

-- ----------------------------------------------------------- add a note ----

create or replace function add_review_note(
  p_code         text,
  p_body         text,
  p_latitude     double precision,
  p_longitude    double precision,
  p_author_name  text,
  p_author_color text default '#1e3a8f',
  p_kind         text default 'other',
  p_hospital_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sess   review_sessions%rowtype;
  note   review_notes%rowtype;
  n_open integer;
begin
  select * into sess
    from review_sessions
   where code = upper(btrim(p_code));

  if not found or sess.closed or sess.expires_at < now() then
    raise exception 'That review session is not open.'
      using errcode = 'no_data_found';
  end if;

  -- A session is a meeting, and no meeting produces a thousand notes. The cap
  -- bounds what one leaked code can do to the table.
  select count(*) into n_open from review_notes where session_id = sess.id;
  if n_open >= 500 then
    raise exception 'This session has reached its note limit.'
      using errcode = 'check_violation';
  end if;

  insert into review_notes (
    session_id, hospital_id, latitude, longitude, kind,
    author_name, author_color, body
  )
  values (
    sess.id,
    p_hospital_id,
    p_latitude,
    p_longitude,
    coalesce(nullif(btrim(p_kind), ''), 'other'),
    coalesce(nullif(btrim(p_author_name), ''), 'Author'),
    coalesce(nullif(btrim(p_author_color), ''), '#1e3a8f'),
    btrim(p_body)
  )
  returning * into note;

  return jsonb_build_object(
    'id',           note.id,
    'hospital_id',  note.hospital_id,
    'latitude',     note.latitude,
    'longitude',    note.longitude,
    'kind',         note.kind,
    'author_name',  note.author_name,
    'author_color', note.author_color,
    'body',         note.body,
    'resolved',     note.resolved,
    'created_at',   note.created_at,
    'replies',      '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------- add a reply ----

create or replace function add_review_reply(
  p_code         text,
  p_note_id      uuid,
  p_body         text,
  p_author_name  text,
  p_author_color text default '#1e3a8f'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sess  review_sessions%rowtype;
  reply review_replies%rowtype;
begin
  select * into sess
    from review_sessions
   where code = upper(btrim(p_code));

  if not found or sess.closed or sess.expires_at < now() then
    raise exception 'That review session is not open.'
      using errcode = 'no_data_found';
  end if;

  -- The note must belong to this session. Without this check a known note id
  -- from one session could be replied to from another.
  if not exists (
    select 1 from review_notes
     where id = p_note_id and session_id = sess.id
  ) then
    raise exception 'That note is not part of this session.'
      using errcode = 'no_data_found';
  end if;

  insert into review_replies (note_id, author_name, author_color, body)
  values (
    p_note_id,
    coalesce(nullif(btrim(p_author_name), ''), 'Author'),
    coalesce(nullif(btrim(p_author_color), ''), '#1e3a8f'),
    btrim(p_body)
  )
  returning * into reply;

  return jsonb_build_object(
    'id',           reply.id,
    'note_id',      p_note_id,
    'author_name',  reply.author_name,
    'author_color', reply.author_color,
    'body',         reply.body,
    'created_at',   reply.created_at
  );
end;
$$;

-- -------------------------------------------------------------- resolve ----

create or replace function set_review_note_resolved(
  p_code     text,
  p_note_id  uuid,
  p_resolved boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sess review_sessions%rowtype;
begin
  select * into sess
    from review_sessions
   where code = upper(btrim(p_code));

  if not found or sess.closed or sess.expires_at < now() then
    raise exception 'That review session is not open.'
      using errcode = 'no_data_found';
  end if;

  update review_notes
     set resolved    = p_resolved,
         resolved_at = case when p_resolved then now() else null end
   where id = p_note_id
     and session_id = sess.id;

  if not found then
    raise exception 'That note is not part of this session.'
      using errcode = 'no_data_found';
  end if;
end;
$$;

-- --------------------------------------------------------------- delete ----
--
-- Anyone in the session may remove a note, which is the same latitude GeoLibre
-- gives a participant. The code is the boundary, and a review session is a room
-- of people who were invited into it.

create or replace function delete_review_note(
  p_code    text,
  p_note_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  sess review_sessions%rowtype;
begin
  select * into sess
    from review_sessions
   where code = upper(btrim(p_code));

  if not found or sess.closed or sess.expires_at < now() then
    raise exception 'That review session is not open.'
      using errcode = 'no_data_found';
  end if;

  delete from review_notes
   where id = p_note_id
     and session_id = sess.id;
end;
$$;


-- ===================================================== function grants =====
--
-- These are the only route to the review tables, so the grants here are the
-- whole access model.

revoke all on function create_review_session(text, text)        from public;
revoke all on function open_review_session(text)                from public;
revoke all on function add_review_note(text, text, double precision, double precision, text, text, text, uuid) from public;
revoke all on function add_review_reply(text, uuid, text, text, text) from public;
revoke all on function set_review_note_resolved(text, uuid, boolean) from public;
revoke all on function delete_review_note(text, uuid)           from public;
revoke all on function generate_review_code()                   from public;

grant execute on function create_review_session(text, text)     to anon, authenticated;
grant execute on function open_review_session(text)             to anon, authenticated;
grant execute on function add_review_note(text, text, double precision, double precision, text, text, text, uuid) to anon, authenticated;
grant execute on function add_review_reply(text, uuid, text, text, text) to anon, authenticated;
grant execute on function set_review_note_resolved(text, uuid, boolean) to anon, authenticated;
grant execute on function delete_review_note(text, uuid)        to anon, authenticated;

-- generate_review_code is called only by create_review_session, which runs as
-- definer. The client never needs it.


-- ======================================================= admin review =====
--
-- For the administrator in the SQL editor. security_invoker so the policies
-- apply through them, and no grant to the client roles, for the same reason
-- the other review views carry none.

create or replace view pending_feedback
with (security_invoker = on) as
  select id, kind, message, contact, hospital_id, page, created_at
    from feedback
   where not handled
   order by created_at;

create or replace view review_session_summary
with (security_invoker = on) as
  select
    s.code,
    s.label,
    s.host_name,
    s.created_at,
    s.expires_at,
    count(n.id)                               as notes,
    count(n.id) filter (where not n.resolved)  as open_notes
  from review_sessions s
  left join review_notes n on n.session_id = s.id
  group by s.id
  order by s.created_at desc;

revoke all on pending_feedback        from anon, authenticated;
revoke all on review_session_summary  from anon, authenticated;


-- ============================================================== check =====
--
-- Run this after applying. Expected for anon, and nothing else:
--
--   feedback              INSERT
--   hospital_suggestions  INSERT
--   hospitals             SELECT
--   public_hospitals      SELECT
--
-- The review tables must not appear at all: they are reached only through the
-- functions above.
--
--   select table_name,
--          string_agg(distinct privilege_type, ', ' order by privilege_type) as anon_can
--     from information_schema.role_table_grants
--    where grantee = 'anon' and table_schema = 'public'
--    group by table_name order by table_name;
