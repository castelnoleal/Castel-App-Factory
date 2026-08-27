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


def run_case(name, package_name, source_type, source_bytes=b"", source_file_name=""):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        manifest = tmp / "manifest.json"
        output = tmp / "generated"
        manifest.write_text(json.dumps({
            "appName": name,
            "packageName": package_name,
            "versionName": "2.3.4",
            "versionCode": 23,
            "sourceType": source_type,
            "sourceUrl": "https://example.com/" if source_type.startswith("HTTPS") else "",
            "sourceFileName": source_file_name,
            "orientation": "portrait",
        }))
        env = os.environ.copy()
        env["BUILD_MANIFEST"] = str(manifest)
        env["BUILD_OUTPUT"] = str(output)
        env["SOURCE_BASE64"] = base64.b64encode(source_bytes).decode() if source_bytes else ""
        subprocess.run(["python3", str(GENERATOR)], cwd=ROOT, env=env, check=True)

        assert (output / "settings.gradle").exists()
        assert (output / "app" / "build.gradle").exists()
        assert (output / "app" / "src" / "main" / "AndroidManifest.xml").exists()
        java = next((output / "app" / "src" / "main" / "java").rglob("MainActivity.java"))
        text = java.read_text()
        assert f"package {package_name};" in text
        assert f"applicationId '{package_name}'" in (output / "app" / "build.gradle").read_text()
        assert "com.castel.generatedapp" not in text
        if source_type.startswith("HTTPS"):
            assert "https://example.com/" in text
        else:
            index = output / "app" / "src" / "main" / "assets" / "index.html"
            assert index.exists()
            assert "Smoke" in index.read_text()


run_case(
    "Smoke Local",
    "com.castel.smokelocal",
    "Uploaded HTML",
    b"<!doctype html><html><body><h1>Smoke local</h1></body></html>",
    "smoke.html",
)

zip_buffer = io.BytesIO()
with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("site/index.html", "<!doctype html><html><body><h1>Smoke ZIP</h1></body></html>")
run_case("Smoke ZIP", "com.castel.smokezip", "Uploaded HTML/ZIP", zip_buffer.getvalue(), "smoke.zip")
run_case("Smoke Website", "com.castel.smokeweb", "HTTPS website")
print("Generator smoke tests passed: HTML, ZIP, and HTTPS website modes.")
