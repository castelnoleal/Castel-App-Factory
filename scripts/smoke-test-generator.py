import io
import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate-app.py"


def run_case(name, package_name, source_type, source_bytes=b"", source_file_name="", build=False):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        manifest = tmp / "manifest.json"
        output = tmp / "generated"
        source_url = "https://example.com/" if source_type.startswith("HTTPS") else ""
        manifest.write_text(json.dumps({
            "appName": name,
            "packageName": package_name,
            "versionName": "2.3.4",
            "versionCode": 23,
            "sourceType": source_type,
            "sourceUrl": source_url,
            "sourceFileName": source_file_name,
            "orientation": "portrait",
            "backNavigation": True,
        }), encoding="utf-8")
        env = os.environ.copy()
        env["BUILD_MANIFEST"] = str(manifest)
        env["BUILD_OUTPUT"] = str(output)
        env["SOURCE_FILE"] = ""
        env["ICON_FILE"] = ""
        if source_bytes:
            source_path = tmp / (source_file_name or "source.bin")
            source_path.write_bytes(source_bytes)
            env["SOURCE_FILE"] = str(source_path)
        subprocess.run(["python3", str(GENERATOR)], cwd=ROOT, env=env, check=True)

        assert (output / "settings.gradle").exists()
        assert (output / "app" / "build.gradle").exists()
        assert (output / "app" / "src" / "main" / "AndroidManifest.xml").exists()
        java = next((output / "app" / "src" / "main" / "java").rglob("MainActivity.java"))
        text = java.read_text(encoding="utf-8")
        assert f"package {package_name};" in text
        assert f"applicationId '{package_name}'" in (output / "app" / "build.gradle").read_text(encoding="utf-8")
        assert "com.castel.generatedapp" not in text
        assert 'Log.i("CastelAppFactory", "PAGE_LOADED:" + url);' in text
        assert "BACK_NAVIGATION" in text
        assert "PLAY_BILLING = false;" in text
        assert not list((output / "app" / "src").rglob("PlayBilling.java")), "Play Billing must only be compiled in when asked for"
        assert not (output / "optional").exists()
        assert "billingclient" not in (output / "app" / "build.gradle").read_text(encoding="utf-8")

        if source_type.startswith("HTTPS"):
            assert 'webView.loadUrl("https://example.com/")' in text
            assert not (output / "app" / "src" / "main" / "assets" / "index.html").exists()
        else:
            index = output / "app" / "src" / "main" / "assets" / "index.html"
            assert index.exists()
            assert "Smoke" in index.read_text(encoding="utf-8")
            if source_file_name.lower().endswith(".zip"):
                assert (output / "app" / "src" / "main" / "assets" / "app.js").exists()

        if build:
            subprocess.run(
                ["gradle", "-p", str(output), "lintDebug", "assembleDebug", "bundleRelease", "--no-daemon", "--stacktrace"],
                cwd=ROOT,
                check=True,
            )
            apk = output / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
            aab = output / "app" / "build" / "outputs" / "bundle" / "release" / "app-release.aab"
            assert apk.is_file() and apk.stat().st_size > 0
            assert aab.is_file() and aab.stat().st_size > 0
            with zipfile.ZipFile(apk) as z:
                assert z.testzip() is None
                assert "classes.dex" in z.namelist()
            with zipfile.ZipFile(aab) as z:
                assert z.testzip() is None


run_case("Smoke Local", "com.castel.smokelocal", "Uploaded HTML", b"<!doctype html><html><body><h1>Smoke local</h1></body></html>", "smoke.html", build=True)

zip_buffer = io.BytesIO()
with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("site/index.html", "<!doctype html><html><body><h1>Smoke ZIP</h1></body></html>")
    z.writestr("site/app.js", "document.body.dataset.smoke='zip';")
run_case("Smoke ZIP", "com.castel.smokezip", "Uploaded HTML/ZIP", zip_buffer.getvalue(), "smoke.zip", build=True)
run_case("Smoke Website", "com.castel.smokeweb", "HTTPS website", build=True)
print("Generator tests passed: HTML generation + APK/AAB build, nested ZIP extraction, and HTTPS website mode.")


def option_case():
    """Every factory switch must change the generated app (regression guard)."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        manifest = tmp / "manifest.json"
        output = tmp / "generated"
        manifest.write_text(json.dumps({
            "appName": "Options Check", "packageName": "com.castel.optionscheck",
            "versionName": "1.0.0", "versionCode": 1,
            "sourceType": "HTTPS website", "sourceMode": "website", "sourceUrl": "http://plain.example.com/",
            "externalLinks": False, "zoom": True, "fullscreen": True, "backNavigation": False,
            "pullToRefresh": True, "keepAwake": True, "allowCamera": True, "allowLocation": True,
            "themeColor": "#FFFFFF", "splashBackground": "#123456", "splashMode": "art", "splashMinMs": 1200,
            "internalHosts": ["accounts.example.com", "not a host"], "userAgentSuffix": "Check/1",
            "updateAlerts": True, "playUpdates": False, "updateFeedUrl": "https://example.com/app/update.json",
            "updateCheckHours": 500, "pageNotifications": True, "brandBadge": True,
        }), encoding="utf-8")
        env = os.environ.copy()
        env.update(BUILD_MANIFEST=str(manifest), BUILD_OUTPUT=str(output), SOURCE_FILE="", ICON_FILE="", SPLASH_FILE="")
        subprocess.run(["python3", str(GENERATOR)], cwd=ROOT, env=env, check=True)
        text = next((output / "app" / "src" / "main" / "java").rglob("MainActivity.java")).read_text(encoding="utf-8")
        for expected in (
            "ALLOW_EXTERNAL_LINKS = false;", "ENABLE_ZOOM = true;", "FULLSCREEN = true;", "BACK_NAVIGATION = false;",
            "PULL_TO_REFRESH = true;", "KEEP_AWAKE = true;", "ALLOW_CAMERA = true;", "ALLOW_LOCATION = true;",
            "THEME_COLOR = 0xFFFFFFFF;", "SPLASH_COLOR = 0xFF123456;", "SPLASH_MIN_MS = 1200;",
            # No splash file supplied, so the app must fall back to the icon splash.
            'SPLASH_MODE = "icon";',
            'INTERNAL_HOSTS = {"accounts.example.com"};', 'USER_AGENT_SUFFIX = "Check/1";',
            'START_URL = "http://plain.example.com/";',
            "UPDATE_ALERTS = true;", "PLAY_UPDATES = false;", 'UPDATE_FEED_URL = "https://example.com/app/update.json";',
            "UPDATE_CHECK_HOURS = 168;", "PAGE_NOTIFICATIONS = true;", "SPLASH_BADGE = true;",
        ):
            assert expected in text, f"generated MainActivity is missing: {expected}"
        manifest_xml = (output / "app" / "src" / "main" / "AndroidManifest.xml").read_text(encoding="utf-8")
        assert "android.permission.CAMERA" in manifest_xml
        assert "android.permission.ACCESS_FINE_LOCATION" in manifest_xml
        assert 'android:usesCleartextTraffic="true"' in manifest_xml
        assert "OPTIONAL_PERMISSIONS" not in manifest_xml
        colors = (output / "app" / "src" / "main" / "res" / "values" / "colors.xml").read_text(encoding="utf-8")
        assert "#123456" in colors and "#FFFFFF" in colors
        assert (output / "app" / "src" / "main" / "res" / "values-v31" / "styles.xml").is_file()
        night = (output / "app" / "src" / "main" / "res" / "values-night" / "styles.xml").read_text(encoding="utf-8")
        assert "Theme.Material.NoActionBar" in night and "Theme.Material.Light" not in night


option_case()
print("Generator option checks passed")


def billing_case():
    """The playBilling option compiles Google Play Billing into the app (Play edition of the factory)."""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        manifest = tmp / "manifest.json"
        output = tmp / "generated"
        manifest.write_text(json.dumps({
            "appName": "instApped", "packageName": "com.castel.billingcheck", "versionName": "1.0.0", "versionCode": 1,
            "sourceType": "HTTPS website", "sourceMode": "website", "sourceUrl": "https://create.instapped.com/",
            "userAgentSuffix": "instApped-Play/billing", "playBilling": True,
        }), encoding="utf-8")
        env = os.environ.copy()
        env.update(BUILD_MANIFEST=str(manifest), BUILD_OUTPUT=str(output), SOURCE_FILE="", ICON_FILE="", SPLASH_FILE="")
        subprocess.run(["python3", str(GENERATOR)], cwd=ROOT, env=env, check=True)
        java_root = output / "app" / "src" / "main" / "java"
        main = next(java_root.rglob("MainActivity.java")).read_text(encoding="utf-8")
        billing = next(java_root.rglob("PlayBilling.java")).read_text(encoding="utf-8")
        assert "PLAY_BILLING = true;" in main and 'USER_AGENT_SUFFIX = "instApped-Play/billing";' in main
        assert "package com.castel.billingcheck;" in billing
        assert "implementation 'com.android.billingclient:billing:8.0.0'" in (output / "app" / "build.gradle").read_text(encoding="utf-8")
        assert not (output / "optional").exists()
        if os.environ.get("BILLING_BUILD", "1") != "0":
            subprocess.run(["gradle", "-p", str(output), "lintDebug", "assembleDebug", "--no-daemon", "--stacktrace"], cwd=ROOT, check=True)
            apk = output / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
            with zipfile.ZipFile(apk) as z:
                assert any(n.startswith("classes") for n in z.namelist())
            merged = [m.read_text(encoding="utf-8") for m in (output / "app" / "build" / "intermediates").rglob("AndroidManifest.xml") if "merged_manifest" in str(m)]
            assert merged and any("com.android.vending.BILLING" in m for m in merged), "BILLING permission missing from the merged manifest"


billing_case()
print("Generator option and Play Billing checks passed.")
