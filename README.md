# Castel App Factory

Commercial HTML/website → Android application factory.

## Pipeline

1. Validate source HTML/ZIP/URL.
2. Generate an isolated Android project.
3. Build and lint on a clean GitHub runner.
4. Produce a debug APK for testing.
5. Produce a release AAB for Play distribution.
6. Record build metadata and artifacts.

## Security

- Never commit Android keystores or signing passwords.
- Release credentials must be supplied through repository/environment secrets.
- Generated apps use AndroidX WebKit `WebViewAssetLoader` for bundled content.
- Network permissions are opt-in for online apps.
- Build success is only reported after the expected artifacts exist and are non-empty.

## Current baseline

- Android API 36 target/compile SDK
- JDK 17
- Android Gradle Plugin 9.4.0
- Gradle 9.6.0
- AndroidX WebKit 1.17.0

The toolchain is pinned rather than using dynamic dependency versions. Update the baseline only through a tested template change.

## Commercial roadmap

- [ ] Web factory UI
- [ ] HTML/ZIP importer
- [ ] Website wrapper mode
- [ ] Project validation engine
- [ ] App/project database
- [ ] Per-app build records
- [ ] Secure release signing via GitHub Actions secrets
- [ ] AAB artifact delivery
- [ ] APK test artifact delivery
- [ ] Play publishing preparation checks
- [ ] Domain deployment

## Verification rule

A project is **not** considered build-verified because source generation succeeded. It is build-verified only when a clean CI run successfully produces the expected APK/AAB artifacts and validation passes.
