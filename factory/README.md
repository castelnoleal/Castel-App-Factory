# Castel App Factory Builder

The builder UI lives at `factory/index.html`.

The intended production flow is:

1. User selects an HTML/ZIP source or HTTPS website.
2. Browser validates app metadata.
3. Browser creates a build manifest.
4. A private build service submits the manifest to GitHub Actions.
5. The Android template is populated with the requested app configuration.
6. CI builds and verifies APK + AAB artifacts.
7. The builder receives artifact metadata and exposes secure downloads.

The current UI is deliberately frontend-only for the control surface. Do not put a GitHub token in browser JavaScript. The bridge must remain server-side/private.
