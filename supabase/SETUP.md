# Supabase setup

Everything below happens in the Supabase dashboard and takes about fifteen minutes. No server administration, and nothing to keep running.

---

## 1. Create the project

At [supabase.com](https://supabase.com), create a new project. Choose a region close to Ghana; Europe (Frankfurt or London) is the usual answer, since Supabase has no African region.

Record the database password it generates. It is needed only for direct Postgres connections, not for this application.

---

## 2. Enable PostGIS and create the schema

Open **SQL Editor** and run the contents of `migrations/0001_core.sql`. The first statement enables PostGIS, so it must run before the rest.

This creates:

- `hospitals`, holding the map data
- `hospital_staff`, linking an account to the hospital it may report for
- `hospital_suggestions`, holding public submissions awaiting review
- Row level security policies on all three

---

## 3. Load the hospitals

Run `seed.sql` in the same editor. It inserts twenty-two Accra hospitals with names, addresses, published phone numbers, and coordinates.

Bed, ICU and oxygen figures are deliberately absent. Those numbers are not public information and must come from the hospitals themselves, so every row starts as `unreported` and the map shows a dash rather than a zero.

To regenerate the file after editing `data/hospitals.geojson`, use the generator described in the project README.

---

## 4. Connect the site

In **Settings → API**, copy the Project URL and the `anon` public key into `site/config.js`.

The anonymous key belongs in the browser. It carries no privileges of its own: every table has row level security, so what the key can read or write is exactly what the policies allow. Published hospitals are readable, updates require a staff assignment, and suggestions can be written but never read back.

The **service role key is different**. It bypasses row level security entirely. It must never appear in `config.js`, in the repository, or anywhere the browser can reach it.

---

## 5. Enable sign-ups and run the second migration

Run `migrations/0002_staff_requests.sql`. This adds the request table, the approval
functions, and a `pending_staff_requests` view for review.

Then, in **Authentication → Sign In / Providers**, make sure email sign-ups are
**enabled**. Staff create their own accounts through `register.html`.

Leaving sign-ups open is safe here because an account grants nothing on its own. Access
comes from a row in `hospital_staff`, which only an approval writes. An unapproved
account can sign in and do precisely nothing.

Also consider turning **off** "Confirm email" while testing, unless SMTP is configured.
With confirmation on, an applicant must click a link before their request can be filed,
and without SMTP that email never arrives.

---

## 6. Approve staff requests

Staff register at `register.html`, choosing their hospital and describing how their role
can be confirmed. Nothing is granted until you approve it.

To see what is waiting:

```sql
select * from pending_staff_requests;
```

That shows the applicant's name, email, job title, phone, the evidence they gave, and
which hospital they claim to work at.

**Confirm the person before approving.** The evidence field is the only thing between a
stranger and a hospital's bed data. Call the hospital's main line, or the supervisor
named, and confirm the person works there. An approved account can change what a
dispatcher sees during an emergency.

To approve:

```sql
select approve_staff_request('<request-id>', 'Confirmed by phone with ward sister');
```

That grants the access and records the decision in one transaction, so the two cannot
come apart.

To decline:

```sql
select reject_staff_request('<request-id>', 'Could not confirm employment');
```

The note is shown to the applicant when they next sign in, so give a reason they can act
on.

To see who currently has access to what:

```sql
select u.email, h.name as hospital, s.created_at
from hospital_staff s
join auth.users u on u.id = s.user_id
join hospitals  h on h.id = s.hospital_id
order by h.name;
```

To remove access:

```sql
delete from hospital_staff
where user_id = (select id from auth.users where email = 'someone@example.com');
```

The account remains and can still sign in; it simply has no hospital again.

---

## 7. Review suggestions

Public submissions land in `hospital_suggestions`. They are never visible on the map.

To see what is waiting:

```sql
select id, name, address, region_area, submitted_by, contact, created_at
from hospital_suggestions
where reviewed = false
order by created_at;
```

Before publishing any of them, check the facility against the HeFRA licensed register. Under the Health Institutions and Facilities Act, 2011 (Act 829), a facility may not lawfully operate without a licence, and an ambulance routed to a place that cannot provide care loses time that patients do not have.

To accept one:

```sql
insert into hospitals (name, type, region_area, address, main_phone, location,
                       listing_status, location_confidence, hefra_licence)
select name, type, region_area, address, main_phone,
       st_point(longitude, latitude)::geography,
       'published', 'unverified', hefra_licence
from hospital_suggestions
where id = '<suggestion-id>';

update hospital_suggestions set reviewed = true where id = '<suggestion-id>';
```

The new hospital is published with `location_confidence` set to `unverified`, so the map warns readers to call before travelling until someone has confirmed the coordinates on the ground.

---

## Things worth knowing

**Free projects pause after a period without activity.** Daily reporting keeps a project awake, but a long university break might not. Check the current threshold on Supabase's pricing page, and open the dashboard before a demo if the project has been idle.

**The suggestion form has no rate limit.** Anyone may insert, which is the point, but it also means the table can be flooded. If that becomes a problem, add a per-IP limit through an edge function, or require sign-in to submit.

**The anonymous key is visible to anyone who views the page.** That is by design. The protection is the policies, not the key, which is why it matters that the policies are correct rather than that the key is hidden.
