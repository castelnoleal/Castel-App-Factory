# Castel App Factory Build Bridge

The Worker source in `worker.js` is intended for the Cloudflare Worker at `api.castelmei.com`.

## Required Worker variables/secrets

Text variables:

- `GITHUB_OWNER=castelnoleal`
- `GITHUB_REPO=castel-app-factory`
- `GITHUB_WORKFLOW=build-app.yml`

Secrets:

- `GITHUB_TOKEN` = a fine-grained GitHub token scoped to `castelnoleal/castel-app-factory`.
- `OPENAI_API_KEY` = OpenAI API key used by the server-side AI build supervisor.

Required GitHub token permissions:

- **Actions: Read and write** — required to dispatch `build-app.yml`.
- **Contents: Read and write** — required to create `build-inputs/<build-id>/manifest.json`, `status.json`, and source chunks.

The OpenAI key is server-side only. Never put either credential in `factory/index.html` or any public repository file.

## AI build supervisor

When `OPENAI_API_KEY` is present, the Worker calls an OpenAI model using function calling before it queues a build. The model receives only normalized build metadata and must call the strict `approve_build` tool. Deterministic validation remains authoritative, and the Worker performs the actual GitHub write and workflow dispatch. This follows the server-side function-calling pattern documented for Cloudflare Workers. 

The selected model is `gpt-5.6-luna` to keep high-volume build supervision relatively cost-efficient. If the OpenAI key is absent, the Worker continues with deterministic validation and reports that the AI supervisor is disabled.

## Endpoints

- `GET /health` — verifies the bridge is online and configured.
- `POST /build` — validates a build request, optionally runs the AI supervisor, stores the build manifest/source in GitHub, and dispatches `build-app.yml`.
- `GET /build/<build-id>` — returns the build status written by GitHub Actions.

## Current upload limit

The Worker limits uploaded HTML/ZIP payloads to approximately 21 MB for the initial GitHub-backed bridge. Website builds are not subject to this source-upload limit. Larger project uploads should move to R2/object storage before commercial scale.

## First production test

Use:

`https://meiocg.org/duel-synapse`

with a unique package such as:

`org.meiocg.duelsynapse`
