# instApped

Commercial-grade HTML/website → Android app builder, branded instApped.

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

- `site/` — public website for instapped.com (landing, legal and support pages). Deploy this folder only.
- `factory/` — instApped browser control panel and project-generation logic.
- `android-template/` — clean Android WebView application template.
- `scripts/` — validation utilities.
- `.github/workflows/` — clean-build and release pipelines.
- `cloudflare-worker/` — the build service at api.instapped.com (builds, licenses, payments, master edition).
- `presets/` — importable projects for the Google Play editions of instApped.
- `tests/` — unit and browser tests run in CI.

## Signing

Never commit a keystore, private signing key, or signing password. Release signing must be injected through GitHub Actions secrets or another secure secret manager.

## Verification rule

A project is **not** considered build-verified because source generation succeeded. It is build-verified only when a clean CI run successfully produces the expected APK/AAB artifacts and the validation job passes.

## Editions

The same factory (`factory/index.html`) runs as four editions. It picks one at start-up; nothing needs a separate copy.

| Edition | Where | How it's detected | Payments |
| --- | --- | --- | --- |
| Web | create.instapped.com | default | PayMongo checkout → license key |
| Master | `https://api.instapped.com/master` | injected by the build service after owner sign-in | none: everything unlocked |
| Play (no purchases) | Google Play app built from `presets/instapped-play-lite.json` | user agent tag `instApped-Play/lite` | none in the app; license keys bought elsewhere can be entered in Settings |
| Play (Google Play Billing) | Google Play app built from `presets/instapped-play-billing.json` | user agent tag `instApped-Play/billing` | Google Play subscriptions → the same license key |

All editions use the same license keys, so a customer's plan works everywhere.

**Publish only one Play edition.** Two near-identical listings break Google Play's repetitive content policy. Ship the no-purchases edition first, or the Billing edition if you want in-app subscriptions. Both use the package `com.instapped.app` and replace each other as updates.

### Master edition (owner only)

- Open `https://api.instapped.com/master` and sign in with the owner token (`CASTEL_SIGNING_ACCESS_TOKEN`). Sign-in sets a 30-day HttpOnly cookie, so the token never sits in the page.
- The build service serves the factory from the `main` branch (cached for 60 seconds), so master always mirrors the public site. Every feature is unlocked: signed builds, Business tools and test builds, with no ads.
- **Owner tools** (in the menu) show:
  - build service configuration
  - issuing complimentary Pro or Business keys
  - looking up a key's plan, expiry and reference
  - revoking by reference (needs the `LICENSES` KV namespace)
- Master stores projects separately from create.instapped.com because it runs on a different site. To move projects across, export them under Settings → Backup and import them on the other site.
- Sign-in is limited to 8 attempts per 15 minutes per IP. Rotating `LICENSE_SECRET` (or `OWNER_SESSION_SECRET`, if set) signs out every session.

### Building the Play editions

1. In the master edition, go to Settings → Backup → Import and import `presets/instapped-play-lite.json` or `presets/instapped-play-billing.json`.
2. Add the icon, check the listing text, and build a signed AAB.
3. Upload it to Play Console as `com.instapped.app`.

The presets point the app at `https://create.instapped.com/` and set the user agent tag.

### Google Play Billing setup (Billing edition only)

1. In Play Console → Monetize → Subscriptions, create the subscriptions `instapped_pro` and `instapped_business`. Give each one auto-renewing base plans with the IDs `monthly` and `annual`. Free-trial offers are optional; the app buys the base plan.
2. In Google Cloud, create a service account and download a JSON key. In Play Console → Users and permissions, invite the service account with *View financial data* and *Manage orders and subscriptions* for the app.
3. Set the build service secrets and variables:
   - `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (secret): the whole JSON key.
   - `PLAY_PACKAGES` (optional): allowed package names, comma separated. Default `com.instapped.app`.
   - `PLAY_PRODUCTS` (optional): a JSON map of product ID to plan. Default `{"instapped_pro":"pro","instapped_business":"business"}`.
4. The app buys through Google Play. `POST /license/play` then:
   - checks the purchase token with the Google Play Developer API
   - acknowledges it (Google refunds purchases left unacknowledged for 3 days)
   - returns a license valid until the subscription's expiry plus one day
   The app restores purchases quietly on launch, which picks up renewals, reinstalls and new phones.

Customers can also add **Google Play Billing** to their own apps (a Business feature, under Create → Offline & updates). It exposes `window.CastelBilling` (`products`, `purchase`, `restore`, `acknowledge`). Their own server must verify purchases.
