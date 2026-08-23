# Castel App Factory Build Bridge

The Worker source in `worker.js` is intended for the Cloudflare Worker at `api.castelmei.com`.

## Required Worker variables/secrets

Text variables:

- `GITHUB_OWNER=castelnoleal`
- `GITHUB_REPO=castel-app-factory`
- `GITHUB_WORKFLOW=build-app.yml`

Secret:

- `GITHUB_TOKEN` = a fine-grained GitHub token scoped to `castelnoleal/castel-app-factory`.

Required repository permissions for the token:

- **Actions: Read and write** — required to dispatch `build-app.yml`.
- **Contents: Read and write** — required to create `build-inputs/<build-id>/manifest.json`, `status.json`, and source chunks.

Do not put the token in `factory/index.html` or any public repository file.

## Endpoints

- `GET /health` — verifies the bridge is online and configured.
- `POST /build` — validates a build request, stores the build manifest/source in GitHub, and dispatches `build-app.yml`.
- `GET /build/<build-id>` — returns the build status written by GitHub Actions.

## Current upload limit

The Worker limits uploaded HTML/ZIP payloads to approximately 21 MB for the initial GitHub-backed bridge. Website builds are not subject to this source-upload limit. Larger project uploads should move to R2/object storage before commercial scale.

## First production test

Use:

`https://meiocg.org/duel-synapse`

with a unique package such as:

`org.meiocg.duelsynapse`
