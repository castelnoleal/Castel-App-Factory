import base64
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
        }), encoding="utf-8")
        env = os.environ.copy()
        env["BUILD_MANIFEST"] = str(manifest)
        env["BUILD_OUTPUT"] = str(output)
        env["SOURCE_BASE64"] = base64.b64encode(source_bytes).decode() if source_bytes else ""
        subprocess.run(["python3", str(GENERATOR)], cwd=ROOT, env=env, check=True)

        assert (output / "settings.gradle").exists()
        assert (output / "app" / "build.gradle").exists()
        assert (output / "app" / "src" / "main" / "AndroidManifest.xml").exists()
        java = next((output / "app" / "src" / "main" / "java").rglob("MainActivity.java"))
        text = java.read_text(encoding="utf-8")
        assert f"package {package_name};" in text
        assert f"applicationId '{package_name}'" in (output / "app" / "build.gradle").read_text(encoding="utf-8")
        assert "com.castel.generatedapp" not in text

        if source_type.startswith("HTTPS"):
            assert 'webView.loadUrl("https://example.com/");' in text
            assert not (output / "app" / "src" / "main" / "assets" / "index.html").exists()
        else:
            index = output / "app" / "src" / "main" / "assets" / "index.html"
            assert index.exists()
            assert "Smoke" in index.read_text(encoding="utf-8")
            if source_file_name.endswith(".zip"):
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
