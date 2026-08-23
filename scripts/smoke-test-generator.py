import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate-app.py"


def run_case(name, package_name, source_type, source_bytes=b""):
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
            assert (output / "app" / "src" / "main" / "assets" / "index.html").exists()


run_case(
    "Smoke Local",
    "com.castel.smokelocal",
    "Uploaded HTML/ZIP",
    b"<!doctype html><html><body><h1>Local smoke test</h1></body></html>",
)
run_case("Smoke Website", "com.castel.smokeweb", "HTTPS website")
print("Generator smoke tests passed: local HTML and HTTPS website modes.")
