# Accra Hospital Bed Availability

A live map of hospital bed, ICU, and oxygen availability across Accra. Hospital staff report status; ambulance dispatchers, families, and clinic doctors search the map and call ahead before traveling.

Built entirely on free and open-source software, self-hosted, with no paid tier and no vendor account required.

---

## Stack

| Layer | Component | Licence | Role |
|---|---|---|---|
| Map UI | GeoLibre | MIT (opengeos) | Map rendering, layer styling, attribute table, mobile and desktop clients |
| Map engine | MapLibre GL JS | BSD-3 | Vector rendering underneath GeoLibre |
| Data + API | GeoLens | Apache-2.0 | PostGIS-backed catalog, OGC API endpoints, sign-in, per-dataset permissions, audit log |
| Database | PostGIS | Open source | Stores hospital records as standard spatial data |
| Basemap | OpenFreeMap / CARTO | Open | Background tiles, no API key |

Nothing in this list meters usage, charges per seat, or expires after a trial.

### Why this replaced the earlier plan

An earlier draft of this project used Airtable for data and Glide for the app. Both are commercial products whose free tiers stop being free once a deployment carries real traffic. GeoLens removes that dependency: it is a self-hosted catalog with its own authentication and role system, so the database, the permissions, and the API all run on infrastructure under project control.

---

## Architecture

```
Hospital Staff                Ambulance / Families / Clinic Doctors
      |                                       |
      | sign in, edit own record              | search, view, call
      v                                       v
+-----------------------------+   +-----------------------------+
|  GeoLibre                    |   |  GeoLibre                    |
|  attribute table + editor     |   |  map view, filters, popups   |
+--------------+---------------+   +--------------+---------------+
               |                                  |
               |  GeoLens plugin writes edits     |  reads signed vector
               |  back feature by feature         |  tiles / OGC Features
               v                                  v
        +--------------------------------------------------+
        |   GeoLens server (FastAPI)                         |
        |   auth, roles, per-dataset permissions, audit log  |
        +--------------------------+-----------------------+
                                   |
                                   v
                          +------------------+
                          |  PostGIS          |
                          |  hospitals table  |
                          +------------------+
```

GeoLibre's GeoLens integration connects to a self-hosted GeoLens server and adds datasets as signed vector tiles, OGC API Features GeoJSON, or server-rendered raster tiles, and writes edits to a GeoJSON-loaded dataset back to the GeoLens server, feature by feature, when the server allows it. That write-back path is what lets hospital staff update bed counts from the same map everyone else reads.

---

## Traffic-light styling

GeoLibre renders a vector layer per-feature when its features carry simplestyle-spec properties: the paint expressions read each feature's own colour and fall back to the flat layer style. So the green / amber / red map needs no custom style file. Each hospital feature carries its own `marker-color`, and `data/update_status.py` recomputes those colours from the reported bed counts.

| State | Meaning | Colour |
|---|---|---|
| available | Beds free across all three categories | green |
| limited | At or below threshold in any category, call first | amber |
| full | Zero beds in any category | red |
| unreported | No report submitted yet | grey |

Colours are taken from a colourblind-safer palette rather than pure red and green, since red-green colour blindness affects roughly 8% of men, and this map is read under time pressure during emergencies.

Thresholds live at the top of `data/update_status.py` and should be set to match the project brief.

Run it after any bulk data change:

```bash
python3 data/update_status.py data/hospitals.geojson
```

---

## Data

`data/hospitals.geojson` holds eight Accra hospitals. Identity fields (name, type, area, address, phone where published) come from public directories and reference sources. Bed, ICU, and oxygen figures are deliberately left null and marked `unreported`, because those numbers are not public and must come from the hospitals themselves.

Before any real deployment:

- Verify every coordinate against the actual building footprint. Several are approximate and marked as such in the `notes` field.
- Confirm every phone number directly with the hospital. Several were not found in public sources and are blank.
- Obtain written agreement from each participating hospital before publishing their bed data.

A map that shows stale or wrong bed counts during an emergency is worse than no map, so the unreported state exists to make missing data visibly missing rather than silently zero.

---

## Running it

### See the map today, with no server

The `site/` folder is a self-contained static site: a public bed finder and a staff
reporting form. Publishing it to GitHub Pages gives a working, shareable map immediately,
with no backend and no cost.

1. Push this repository to GitHub.
2. In the repository settings, under Pages, set the source to GitHub Actions.
3. Push to `main`. The workflow in `.github/workflows/pages.yml` validates the dataset
   (it fails the build if any hospital lands outside Greater Accra) and deploys `site/`.

The public page reads `data/hospitals.geojson` directly, so the map, filters, status
colours and tap-to-call all work at this stage. Only the staff form needs a server.

### Add the server, when staff need to report

The staff form talks to GeoLens. See `geolens/SETUP.md` for the installer, publishing the
dataset, granting each staff account editor access to its own hospital, and confirming the
write endpoint against the running instance.

### Alternative: open the data in full GeoLibre

GeoLibre Web opens hosted data directly through a `data` query parameter, which accepts
GeoJSON among other formats. Once the site is published:

```
https://web.geolibre.app/?data=https://<username>.github.io/<repo>/data/hospitals.geojson
```

That gives the whole GeoLibre interface over the same dataset: attribute table, styling
panel, layer controls, and the browser geoprocessing toolbox.

---

## Hosting and the custom domain

GitHub Pages serves static files, so it hosts `site/` and the GeoJSON. It cannot host
GeoLens, which needs a server, a database and persistent storage.

Staged path:

1. **Now:** GitHub Pages serves the finder. Read-only, free, works today.
2. **Next:** run GeoLens on a VM, publish the dataset into it, staff reporting goes live.
3. **Then:** point the custom domain at the server, serving the static pages from the
   same origin so there are no CORS or cookie problems.

For the domain, GitHub Pages takes a `CNAME` file in the repository containing the domain,
plus a DNS CNAME record pointing at `<username>.github.io`. The GeoLibre project uses this
same pattern: its plugin registry lives in the `opengeos/geolibre-plugins` repo and is
published to GitHub Pages at `plugins.geolibre.app`.

---

## Roles

GeoLens provides admin, editor, and viewer roles with per-dataset permissions, plus OAuth (Google, Microsoft, OIDC) and JWT sessions, and an audit log of who did what.

| User | Role | What they do |
|---|---|---|
| Hospital staff | Editor, scoped to own hospital | Update bed counts twice daily |
| Ambulance dispatchers | Viewer | Find nearest available bed during emergencies |
| Families, private drivers | Viewer (public) | Find nearest hospital, call ahead |
| Clinic doctors | Viewer | Find referral hospitals with space |
| System administrator | Admin | Manage hospitals, accounts, permissions |

The audit log matters here beyond convenience: when a dispatcher acts on a bed count, there is a record of who reported it and when.

---

## Still to decide

- Whether hospital staff edit through the GeoLibre attribute table or a simpler purpose-built form. The attribute table works immediately and needs no extra code; a dedicated form is friendlier for staff on a phone at shift change.
- Whether SMS reporting is in scope. Carriers charge per message on every platform, so this is the one piece that cannot be free. The earlier Twilio webhook from this project still applies if it is wanted.
- Real bed data, which requires hospital participation agreements before anything goes live.


---

## The two pages

`site/index.html` is the public finder. Colour is reserved entirely for status: the
status band, the tag and the map pin are the only chromatic elements on the page, so the
one thing that stands out is the answer to "can I go here". Bed counts render as
monospace readouts with tabular figures, which keeps digits aligned when scanning a list
under pressure. A hospital that has not reported shows an em dash, never a zero.

`site/staff.html` is the reporting form. It signs in against GeoLens, loads the hospitals
the account can see, prefills the current counts, previews the resulting status colour
before submission, and refuses to submit until all three counts and a reporter name are
filled in. Every failure state names what went wrong and what to do: a permissions error
says to ask an administrator for editor access on that hospital, and an endpoint mismatch
points at `/api/docs`.

The status thresholds are duplicated in three places by necessity: `data/update_status.py`,
`site/index.html` and `site/staff.html`. They are cross-checked by a test that runs both
the Python and JavaScript implementations over the same cases. If you change one, change
all three.
