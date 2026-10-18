# Sandbox: private artifact storage setup

This document applies only to `sandbox/private-downloads`. Do not deploy this branch's Worker or merge it into `main` until the bucket and end-to-end tests are complete.

## What is implemented

- The sandbox Worker checks the private R2 binding `ARTIFACTS` first for `builds/<build-id>/apk.apk` and `builds/<build-id>/aab.aab`.
- The sandbox build workflow uploads APK/AAB files to R2 when all four GitHub Actions secrets are configured.
- If R2 is not configured or an object is absent, the current Worker still falls back to GitHub Releases. This is transitional compatibility, not private-only mode.

## Required Cloudflare setup

1. In Cloudflare R2, create a **private** bucket named `castel-app-factory-artifacts-sandbox`. Do not enable public bucket access.
2. Create an R2 API token limited to read/write access to this bucket.
3. Add these repository Actions secrets (sandbox testing uses the repository's Actions secrets, so do not put secrets in source code):
   - `CF_R2_ACCOUNT_ID`
   - `CF_R2_ACCESS_KEY_ID`
   - `CF_R2_SECRET_ACCESS_KEY`
   - `CF_R2_BUCKET` (value: `castel-app-factory-artifacts-sandbox`)
4. Bind the same bucket to the **sandbox Worker deployment** as `ARTIFACTS`. Do not update the production Worker yet.
5. Deploy the sandbox Worker to a separate Worker name/route or a separate staging subdomain. Do not deploy the production Worker name from this branch.
6. Run a test build and verify both files are stored privately and can be downloaded through the sandbox Worker URL.

## Before production promotion

- Add short-lived signed download tokens or an authenticated download session; UUID build IDs are hard to guess but are not authorization by themselves.
- Ensure all artifact links in build status use the sandbox/custom domain, not GitHub URLs.
- Disable the GitHub Release fallback after private storage has been verified, or explicitly retain it only for legacy builds.
- Stop publishing public GitHub Releases for new builds.
- Consider private repository visibility and remove sensitive source/build inputs from public branches. R2 artifact storage alone does not privatize source branches.
- Verify Android APK downloads from the appified Factory, not only from desktop Chrome.
