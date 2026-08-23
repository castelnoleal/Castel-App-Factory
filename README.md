# Castel App Factory

Commercial-grade HTML/website → Android app factory.

## Goals

- Generate Android apps from uploaded HTML/ZIP projects or HTTPS websites.
- Produce reproducible Android projects.
- Build a debug APK for testing.
- Build a release AAB for Google Play distribution.
- Validate package name, version code, target API, manifest, icons, and source layout before building.
- Keep signing credentials outside source control.
- Support a growing catalogue of separately versioned customer apps.

## Current platform baseline

- Target API: 36 (Google Play requirement for new mobile apps and updates beginning August 31, 2026).
- Android Gradle Plugin: 9.4.0.
- Gradle: 9.6.0.
- JDK: 17.
- AndroidX WebKit: 1.17.0.

The exact versions are centralized so the build template can be upgraded deliberately after compatibility testing.

## Repository layout

- `factory/` — browser control panel and project-generation logic.
- `android-template/` — clean Android WebView application template.
- `scripts/` — validation utilities.
- `.github/workflows/` — clean-build and release pipelines.
- `docs/` — architecture and operating procedures.

## Signing

Never commit a keystore, private signing key, or signing password. Release signing must be injected through GitHub Actions secrets or another secure secret manager.

## Verification rule

A project is **not** considered build-verified because source generation succeeded. It is build-verified only when a clean CI run successfully produces the expected APK/AAB artifacts and the validation job passes.

## Robust CI gate

The verification workflow also exercises the project generator in HTML, ZIP, and HTTPS website modes before compiling the Android template. Production generated-app builds separately verify generated package identity, source handling, APK/AAB integrity, and write an explicit build status record.
