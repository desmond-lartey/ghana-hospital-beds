# Accra Hospital Bed Availability

A live map of emergency, ICU, and general ward bed availability across hospitals in Accra. Hospital staff report their counts twice daily. Ambulance dispatchers, families, and clinic doctors search the map and call ahead before travelling.

The system runs on a static site and a managed database. Nothing needs to be kept running by hand, and both layers have free tiers sufficient for this workload.

---

## Contents

- [Stack](#stack)
- [Architecture](#architecture)
- [Status model](#status-model)
- [Access model](#access-model)
- [Data](#data)
- [Interfaces](#interfaces)
- [Deployment](#deployment)
- [Repository layout](#repository-layout)
- [Open questions](#open-questions)

---

## Stack

| Layer | Component | Role |
|---|---|---|
| Pages | GitHub Pages | Serves the three static pages and the fallback dataset |
| Data | Supabase (Postgres + PostGIS) | Hospital records, authentication, row level security |
| Map | MapLibre GL JS | Vector rendering |
| Basemap | OpenFreeMap | Background tiles, no API key |
| GIS (optional) | GeoLibre | Analysis and field capture over the same data |

There is no application server. The browser talks to Postgres through Supabase's REST layer, and the database enforces who may do what.

### Design rationale

An earlier version of this system used a self-hosted catalog running in a container. It worked, but it required a machine that never sleeps, and the failure mode was severe: when the host stopped, hospital staff could not report at all.

Two properties matter more than any feature here. The read path must survive anything, because someone opens this during an emergency. The write path must not depend on a machine somebody remembers to start.

Static hosting satisfies the first: the map is files on a CDN, with no server to fail. A managed database satisfies the second, without anyone administering it.

Row level security is what makes the missing server acceptable. Access rules live in the database rather than in application code, so the browser can hold a public key and still be unable to do anything the policies forbid.

---

## Architecture

```mermaid
flowchart LR
  Public[Dispatchers, families,<br/>clinic doctors] --> Finder[Public bed finder<br/>site/index.html]
  Staff[Hospital staff] --> Form[Staff reporting<br/>site/staff.html]
  Anyone[Anyone] --> Suggest[Suggest a hospital<br/>site/suggest.html]

  Finder -->|read published| DB[(Supabase<br/>Postgres + PostGIS<br/>row level security)]
  Form -->|update own hospital| DB
  Suggest -->|insert, never read| DB

  Finder -.->|when unreachable| File[Static GeoJSON<br/>on GitHub Pages]
  DB --> GeoLibre[GeoLibre<br/>optional GIS]
```

The public map reads Supabase when it can and falls back to the dataset published alongside the page when it cannot. Live counts when the database is reachable, last-known counts when it is not, and never a blank map.

---

## Status model

Each hospital carries one of four states.

| State | Condition | Meaning to the reader |
|---|---|---|
| Available | Beds free in all three categories | Space is expected |
| Limited | At or below threshold in any category | Call before travelling |
| Full | Zero beds in any category | No capacity |
| Not reported | No counts submitted | Availability unknown |

Status is a **generated column** in Postgres, computed from the bed counts and never written by a client. Earlier versions of this project duplicated the threshold logic across three files and relied on keeping them in step. Deriving it in the database removes that possibility: a client cannot report counts that disagree with the colour shown on the map.

Default thresholds are three emergency beds, two ICU beds, and five general ward beds, set in `supabase/migrations/0001_core.sql`.

The not-reported state is deliberate. A hospital that has not submitted counts renders a dash rather than a zero, because a zero is a claim about capacity and an absent report is not. Distinguishing the two prevents a dispatcher reading missing data as a full ward.

Status colours use a colourblind-safe palette rather than pure red and green. Red-green colour blindness affects roughly eight percent of men, and the map is read under time pressure where misreading a colour has direct consequences.

---

## Access model

Three tiers, enforced by row level security rather than by application code.

| Tier | Who | Can do | Cannot do |
|---|---|---|---|
| Public | Anyone, signed in or not | Read published hospitals, submit a suggestion | Read suggestions, alter any hospital |
| Staff | Account linked to a hospital | Update that hospital's counts | Touch any other hospital |
| Administrator | Supabase dashboard | Publish, assign staff, review suggestions | — |

A staff account is two things: a user, and a row in `hospital_staff` linking it to a hospital. Without the link the account signs in but sees nothing and can change nothing. That is the intended behaviour, not a fault.

Suggestions are held in a separate table that anyone may write to and nobody may read from. An anonymous submission therefore cannot reach the map, and the submitter's contact details are not publicly readable.

### Why suggestions are gated

The Health Institutions and Facilities Act, 2011 (Act 829) established the Health Facilities Regulatory Agency (HeFRA), which licenses health facilities in Ghana. Section 11(1) provides that a facility may not operate unless licensed.

Two failure modes justify review. An ambulance routed to a facility that does not exist, or cannot provide the care needed, loses time measured in minutes. And publishing an unlicensed facility would direct patients to an operation not lawfully permitted to treat them. Neither is an acceptable price for the convenience of open self-registration.

---

## Data

`data/hospitals.geojson` holds twenty-two Accra hospitals and remains the source of truth for hospital identity. `supabase/seed.sql` is generated from it by `data/generate_seed.py`, so edits are made to the GeoJSON and the SQL is derived.

Identity fields come from public directories. Bed, ICU and oxygen figures are null, because those figures are not public and must originate from the hospitals themselves.

### Prerequisites for production use

- Verify every coordinate against the actual building. Nineteen of twenty-two are approximate and flagged as such; the map warns readers on these.
- Confirm every phone number with the hospital. Several were not found in public sources and are blank.
- Obtain written agreement from each participating hospital before publishing its bed data.

GeoLibre's field collection tool is suited to the coordinate work: it captures a point from device GPS with an optional photo, and works offline, so positions can be confirmed on site and exported back into the dataset.

---

## Interfaces

**`site/index.html`** is the public finder, requiring no account. Colour is reserved exclusively for status, so the most prominent thing on screen is whether a hospital can accept a patient. Bed counts render as monospace readouts with tabular figures, which keeps digits aligned when a list is scanned quickly. Directions open turn-by-turn routing from the reader's current location.

**`site/staff.html`** signs in against Supabase, lists only the hospitals the account may edit, prefills current counts, previews the resulting status before submission, and requires all three counts plus a reporter name. The session persists, so staff are not asked to sign in twice a day.

**`site/suggest.html`** accepts facility proposals from anyone, validates coordinates against the Greater Accra bounding box, and offers device geolocation instead of typing coordinates by hand. Rejecting out-of-area points catches transposed latitude and longitude, which is the most consequential data-entry error in the system.

---

## Deployment

### Database

See `supabase/SETUP.md`. Create the project, run the migration and seed, copy the project URL and anonymous key into `site/config.js`, then create staff accounts and assign them to hospitals.

### Site

1. Push the repository to GitHub.
2. Under repository settings, in the Pages section, set the source to GitHub Actions.
3. Push to `main`.

The workflow validates the dataset before deploying and fails the build if any hospital falls outside Greater Accra, preventing a bad coordinate from reaching the live map.

The site works before the database is connected: with `config.js` unedited, the map serves the static dataset and the two forms explain that no database is configured.

### Custom domain

GitHub Pages takes a `CNAME` file containing the domain, plus a DNS CNAME record pointing at `<username>.github.io`.

---

## Repository layout

```
.
├── data/
│   ├── hospitals.geojson       Source of truth for hospital identity
│   ├── generate_seed.py        Derives seed.sql from the GeoJSON
│   └── update_status.py        Recomputes status in the GeoJSON fallback
├── site/
│   ├── index.html              Public bed finder
│   ├── staff.html              Staff reporting
│   ├── suggest.html            Public facility suggestion
│   ├── config.js               Supabase URL and anonymous key
│   ├── favicon.svg
│   └── data/                   Dataset copy served by Pages
├── supabase/
│   ├── migrations/0001_core.sql  Schema, policies, generated status
│   ├── seed.sql                  Generated hospital records
│   └── SETUP.md                  Dashboard walkthrough
└── .github/workflows/pages.yml   Validation and deployment
```

---

## Open questions

**Suggestion abuse.** The suggestion table accepts anonymous inserts with no rate limit. Acceptable while the project is small; a per-IP limit or a sign-in requirement would be needed at scale.

**Project pausing.** Supabase pauses free projects after a period of inactivity. Daily reporting keeps it awake, but a long university break might not.

**SMS reporting.** Carriers charge per message on every platform, so this is the one component that cannot be free. Out of scope pending a decision on whether the cost is justified for hospitals without reliable data access.

**Hospital participation.** Live bed data requires agreements with each participating hospital. No production deployment is possible until these are in place.

---

## Licence and attribution

Built with [MapLibre GL JS](https://maplibre.org/) (BSD-3), [OpenFreeMap](https://openfreemap.org/) tiles, [Supabase](https://supabase.com/) (Apache-2.0), and optionally [GeoLibre](https://geolibre.app/) (MIT).

This system is a student project and is not an official emergency service. In an emergency in Ghana, contact the National Ambulance Service on 112.
