# GeoLens setup

GeoLens ships its own installer and compose stack, so this project does not maintain
one.

GeoLens is Apache-2.0 licensed and self-hosted. It stores everything in PostGIS and
serves OGC API Features, which is what the map and the staff form both read.

## Install

```bash
curl -fsSL https://getgeolens.com/install.sh | sh
```

The installer copies `.env.example` to `.env`, generates a JWT signing secret, sets up
admin credentials, and runs `docker compose up -d`. Wait about sixty seconds, then open
http://localhost:8080.

The admin username defaults to `admin`. The password is auto-generated and written to
`.env`. Retrieve it with:

```bash
grep '^GEOLENS_ADMIN_PASSWORD=' .env
```

To read the installer before running it, clone the repository and run the same script
from source; it then builds the images locally instead of pulling them.

Each GitHub release attaches a `SHA256SUMS` file, so the installer can be verified
before execution. Worth doing, since the one-line form pipes a downloaded script
straight into a shell.

**Prerequisites:** Docker Engine 24+ and Docker Compose v2. Ports 5434, 8001 and 8080
are used by default; change `DB_PORT`, `API_PORT` or `FRONTEND_PORT` in `.env` if they
are already taken.

## Publish the hospital dataset

```bash
pip install geolens-cli
geolens login http://localhost:8080/api
geolens publish data/hospitals.geojson --name "Accra hospital beds"
```

`geolens publish` runs the upload, preview and commit ingest flow, then prints the new
dataset's URL.

## Give hospital staff scoped access

GeoLens has role-based access control with per-dataset permissions, so each staff
account can be limited to the hospital it belongs to. In the admin interface:

1. Create a user account per hospital reporter.
2. Assign the editor role rather than admin.
3. Grant edit permission on the hospitals dataset only.

Administrative actions are audit logged, so there is a record of who changed what and
when. That record matters here: when a dispatcher acts on a bed count, the provenance
of that number is part of the safety story, not an afterthought.

## Confirm the write endpoint

`site/staff.html` submits a `PATCH` to:

```
/api/collections/{collectionId}/items/{featureId}
```

That follows the OGC API Features convention, but GeoLens is young and its README
notes that some APIs may still change. Before relying on the form, open the interactive
Swagger UI at http://localhost:8080/api/docs, find the feature-update operation for your
version, and adjust the `path` and `method` in the `submitReport` function if they
differ. The form surfaces a specific message pointing at `/api/docs` if the endpoint
returns 404 or 405, so a mismatch is visible rather than silent.

## Connect GeoLibre to it

GeoLibre ships a GeoLens catalog browser plugin that connects to a self-hosted GeoLens
server, searches its catalog, and adds datasets as signed vector tiles or OGC API
Features GeoJSON, with a metadata link back to each dataset's page. Point it at the
server above to browse and edit the dataset inside the full GeoLibre interface, with its
attribute table, styling panel and geoprocessing tools.

Run GeoLibre alongside it:

```bash
docker run --rm -p 8081:80 -e GEOLIBRE_DISABLE_SIDECAR=1 ghcr.io/opengeos/geolibre:latest
```

Serving GeoLibre and GeoLens from the same origin behind one reverse proxy avoids the
CORS and cookie problems that appear when the app and its data sit on different hosts.
