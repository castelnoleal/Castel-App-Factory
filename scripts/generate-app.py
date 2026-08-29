import base64
import json
import os
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "android-template"


def fail(message):
    raise SystemExit(message)


def safe_zip_extract(zf, destination):
    destination = destination.resolve()
    total_uncompressed = 0
    max_uncompressed = 250 * 1024 * 1024
    for info in zf.infolist():
        member = Path(info.filename)
        if member.is_absolute() or ".." in member.parts:
            fail(f"Unsafe ZIP entry: {info.filename}")
        total_uncompressed += max(0, info.file_size)
        if total_uncompressed > max_uncompressed:
            fail("ZIP expands beyond the 250 MB safety limit")
        target = (destination / member).resolve()
        if destination != target and destination not in target.parents:
            fail(f"Unsafe ZIP entry: {info.filename}")
    zf.extractall(destination)


def find_index(root):
    for candidate in (root / "index.html", root / "index.htm"):
        if candidate.is_file():
            return candidate
    matches = sorted(
        [p for p in root.rglob("index.html") if p.is_file()],
        key=lambda p: (len(p.relative_to(root).parts), str(p).lower()),
    )
    return matches[0] if matches else None


def normalize_local_site(assets):
    index = find_index(assets)
    if index is None:
        fail("No index.html found in uploaded source")
    target = assets / "index.html"
    if index.resolve() != target.resolve():
        source_dir = index.parent
        for child in source_dir.iterdir():
            destination = assets / child.name
            if child.resolve() == destination.resolve():
                continue
            if child.is_dir():
                shutil.copytree(child, destination, dirs_exist_ok=True)
            else:
                shutil.copy2(child, destination)
    return target


def is_web_source(source_type, source_url):
    if not source_url:
        return False
    kind = source_type.lower().strip()
    return kind in {
        "https website", "https website url", "http website", "http website url",
        "website", "website url", "web", "url"
    }


def clean_url(value):
    return str(value or "").strip().strip('"').strip("'")


def generate():
    manifest_path = Path(os.environ["BUILD_MANIFEST"])
    output = Path(os.environ.get("BUILD_OUTPUT", "generated-app"))
    cfg = json.loads(manifest_path.read_text(encoding="utf-8"))

    name = str(cfg.get("appName", "")).strip()
    package_name = str(cfg.get("packageName", "")).strip()
    version = str(cfg.get("versionName", "")).strip()
    version_code = int(cfg.get("versionCode", 0))
    source_type = str(cfg.get("sourceType", "Uploaded HTML/ZIP")).strip()
    source_url = clean_url(cfg.get("sourceUrl") or cfg.get("url") or "")

    if not name:
        fail("appName is required")
    if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", package_name):
        fail("Invalid package name")
    if not re.fullmatch(r"\d+(\.\d+){0,2}", version):
        fail("Invalid version")
    if version_code < 1:
        fail("Invalid version code")

    web_source = is_web_source(source_type, source_url)
    if web_source:
        if not re.fullmatch(r"https?://[^\s]+", source_url, re.IGNORECASE):
            fail("Website source must use a valid HTTP or HTTPS URL")
    elif not os.environ.get("SOURCE_BASE64"):
        fail("Uploaded HTML/ZIP source is missing")

    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(TEMPLATE, output)
    for path in (output / ".gradle", output / "build", output / "app" / "build"):
        if path.exists():
            shutil.rmtree(path)

    gradle_file = output / "app" / "build.gradle"
    text = gradle_file.read_text(encoding="utf-8")
    text = re.sub(r"namespace '.*?'", f"namespace '{package_name}'", text)
    text = re.sub(r"applicationId '.*?'", f"applicationId '{package_name}'", text)
    text = re.sub(r"versionCode \d+", f"versionCode {version_code}", text)
    text = re.sub(r"versionName '.*?'", f"versionName '{version}'", text)
    gradle_file.write_text(text, encoding="utf-8")

    java_root = output / "app" / "src" / "main" / "java"
    java_files = list(java_root.rglob("*.java"))
    target_root = java_root / package_name.replace(".", "/")
    target_root.mkdir(parents=True, exist_ok=True)
    for source in java_files:
        content = source.read_text(encoding="utf-8")
        content = re.sub(r"^package\s+[^;]+;", f"package {package_name};", content, count=1, flags=re.MULTILINE)
        target_url = source_url if web_source else "https://appassets.androidplatform.net/assets/index.html"
        java_url = target_url.replace("\\", "\\\\").replace('"', '\\"')
        content = content.replace("__TARGET_URL__", java_url)
        content = content.replace("__ALLOW_EXTERNAL_LINKS__", "true" if bool(cfg.get("externalLinks")) else "false")
        content = content.replace("__ENABLE_ZOOM__", "true" if bool(cfg.get("zoom")) else "false")
        content = content.replace("__FULLSCREEN__", "true" if bool(cfg.get("fullscreen")) else "false")
        source.write_text(content, encoding="utf-8")
        target = target_root / source.name
        if source.resolve() != target.resolve():
            shutil.move(str(source), str(target))
    for directory in sorted([p for p in java_root.rglob("*") if p.is_dir()], reverse=True):
        try:
            directory.rmdir()
        except OSError:
            pass

    manifest = output / "app" / "src" / "main" / "AndroidManifest.xml"
    manifest_text = manifest.read_text(encoding="utf-8")
    escaped_name = name.replace("&", "&amp;").replace('"', "&quot;")
    manifest_text = re.sub(r'android:label="[^"]*"', f'android:label="{escaped_name}"', manifest_text, count=1)
    orientation = str(cfg.get("orientation", "unspecified"))
    if orientation not in {"unspecified", "portrait", "landscape", "sensor", "fullSensor"}:
        fail("Invalid orientation")
    manifest_text = re.sub(r'android:screenOrientation="[^"]*"', f'android:screenOrientation="{orientation}"', manifest_text, count=1)
    manifest.write_text(manifest_text, encoding="utf-8")

    settings = output / "settings.gradle"
    if settings.exists():
        project_name = re.sub(r"[^A-Za-z0-9_-]", "_", name)
        settings_text = settings.read_text(encoding="utf-8")
        settings_text = re.sub(r"rootProject\.name\s*=\s*'.*?'", f"rootProject.name = '{project_name}'", settings_text)
        settings.write_text(settings_text, encoding="utf-8")

    assets = output / "app" / "src" / "main" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    # ZIP-ASSET-FIX: remove template web assets before importing uploaded site content.
    if not web_source:
        for child in list(assets.iterdir()):
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    if not web_source:
        for child in list(assets.iterdir()):
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

        raw = base64.b64decode(os.environ["SOURCE_BASE64"], validate=True)
        source_name = str(cfg.get("sourceFileName", "")).lower().strip()
        source_is_zip = source_name.endswith(".zip")
        if source_is_zip:
            archive = output / "_source.zip"
            archive.write_bytes(raw)
            try:
                with zipfile.ZipFile(archive) as zf:
                    if zf.testzip() is not None:
                        fail("Uploaded ZIP is corrupt")
                    safe_zip_extract(zf, assets)
            except zipfile.BadZipFile:
                fail("Uploaded ZIP is corrupt or invalid")
            finally:
                archive.unlink(missing_ok=True)
        else:
            (assets / "index.html").write_bytes(raw)
        normalize_local_site(assets)

    print(f"Generated {name} ({package_name}) at {output}")


if __name__ == "__main__":
    generate()
