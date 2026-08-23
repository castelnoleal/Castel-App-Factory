# Castel App Factory build bridge

This Worker is the server-side bridge between the public Factory UI and the private GitHub repository. Keep the GitHub token in the Worker secret store; never put it in `factory/index.html`.

Required secrets:
- `GITHUB_TOKEN`: fine-grained token with only the repository Actions + Contents permissions needed by this private repository.
- `GITHUB_OWNER`: `castelnoleal`
- `GITHUB_REPO`: `castel-app-factory`

The Worker accepts a validated build manifest, stores the source in a per-project build-input directory, and dispatches the build workflow. This is intentionally a separate layer so the public UI never receives repository credentials.

Deploy the Worker at a private API route such as `/api/build` and configure the Factory UI's `BUILD_API_URL` to that endpoint.
