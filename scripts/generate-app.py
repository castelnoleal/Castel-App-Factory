import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
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
        if index.exists() and index.resolve() != target.resolve():
            shutil.copy2(index, target)
    return target


def install_app_icon(icon_file, icon_file_name, output):
    if not icon_file:
        return
    source_path = Path(icon_file)
    if not source_path.is_file():
        fail("Uploaded app icon file is missing")
    raw_size = source_path.stat().st_size
    if raw_size > 6 * 1024 * 1024:
        fail("Uploaded app icon exceeds the 6 MB limit")
    if not re.search(r"\.(png|jpe?g|webp)$", icon_file_name or "", re.IGNORECASE):
        fail("App icon must be PNG, JPG, JPEG, or WebP")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        source = tmp / ("icon" + Path(icon_file_name).suffix.lower())
        shutil.copy2(source_path, source)
        try:
            subprocess.run(["convert", "-version"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (FileNotFoundError, subprocess.CalledProcessError):
            fail("ImageMagick is required to process app icons")

        # Android launcher density buckets. The source is center-cropped to a square
        # so rectangular uploads still produce predictable launcher assets.
        sizes = {
            "mdpi": 48,
            "hdpi": 72,
            "xhdpi": 96,
            "xxhdpi": 144,
            "xxxhdpi": 192,
        }
        res = output / "app" / "src" / "main" / "res"
        for density, size in sizes.items():
            folder = res / f"mipmap-{density}"
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / "ic_launcher.png"
            subprocess.run([
                "convert", str(source),
                "-auto-orient",
                "-alpha", "on",
                "-background", "none",
                "-thumbnail", f"{size}x{size}^",
                "-gravity", "center",
                "-extent", f"{size}x{size}",
                "-strip",
                "PNG32:" + str(target),
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

            round_target = folder / "ic_launcher_round.png"
            shutil.copy2(target, round_target)

        # Generate a true adaptive launcher icon for Android 8+ with a transparent
        # background. The source remains transparent as the foreground layer.
        drawable = res / "drawable-nodpi"
        drawable.mkdir(parents=True, exist_ok=True)
        adaptive_foreground = drawable / "ic_launcher_foreground.png"
        subprocess.run([
            "convert", str(source),
            "-auto-orient",
            "-alpha", "on",
            "-background", "none",
            "-thumbnail", "288x288^",
            "-gravity", "center",
            "-extent", "288x288",
            "-strip",
            "-background", "none",
            "-gravity", "center",
            "-extent", "432x432",
            "PNG32:" + str(adaptive_foreground),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        # Remove the template's adaptive/vector launcher definitions so Android
        # resolves the generated density-specific PNGs above on every API level.
        for xml_path in (
            res / "mipmap-anydpi" / "ic_launcher.xml",
            res / "mipmap-anydpi" / "ic_launcher_round.xml",
            res / "mipmap-anydpi-v26" / "ic_launcher.xml",
            res / "mipmap-anydpi-v26" / "ic_launcher_round.xml",
        ):
            if xml_path.exists():
                xml_path.unlink()

        adaptive_dir = res / "mipmap-anydpi-v26"
        adaptive_dir.mkdir(parents=True, exist_ok=True)
        adaptive_xml = '''<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@android:color/transparent" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
'''
        (adaptive_dir / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
        (adaptive_dir / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")

        # Keep common app assets for future generated screens/features.
        common = res / "drawable-nodpi"
        common.mkdir(parents=True, exist_ok=True)
        subprocess.run([
            "convert", str(source),
            "-auto-orient",
            "-alpha", "on",
            "-background", "none",
            "-thumbnail", "512x512^",
            "-gravity", "center",
            "-extent", "512x512",
            "-strip",
            "PNG32:" + str(common / "app_icon.png"),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


HEX_COLOR = re.compile(r"^#?([0-9a-fA-F]{6})$")
HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")


def java_bool(value):
    return "true" if value else "false"


def java_string(value):
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def set_option(content, name, value):
    """Rewrite one `private static final <type> NAME = ...;` build option.

    Fails loudly if the template no longer declares the option, so a factory
    setting can never be silently ignored again.
    """
    pattern = re.compile(r"(private static final [A-Za-z\[\]]+ " + re.escape(name) + r" = )[^;]*;")
    new, count = pattern.subn(lambda m: m.group(1) + value + ";", content, count=1)
    if count != 1:
        fail(f"Android template is missing the {name} build option")
    return new


def parse_color(value, default):
    match = HEX_COLOR.match(str(value or "").strip())
    hex6 = (match.group(1) if match else default.lstrip("#")).upper()
    return "#" + hex6, "0xFF" + hex6


def is_light(hex_color):
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6


def clean_hosts(value):
    items = value if isinstance(value, list) else str(value or "").split(",")
    hosts = []
    for item in items:
        host = str(item).strip().lower()
        host = re.sub(r"^[a-z]+://", "", host).split("/")[0].split(":")[0]
        if host.startswith("*."):
            host = host[2:]
        if host and HOST_RE.match(host) and host not in hosts:
            hosts.append(host)
    return hosts[:20]


def install_splash_art(splash_file, splash_file_name, background_hex, output):
    """Install the uploaded splash art as res/drawable-nodpi/splash_art.jpg."""
    if not splash_file:
        return False
    source_path = Path(splash_file)
    if not source_path.is_file():
        print("Splash art file is missing; falling back to the icon splash")
        return False
    if source_path.stat().st_size > 8 * 1024 * 1024:
        fail("Splash art exceeds the 8 MB limit")
    if not re.search(r"\.(png|jpe?g|webp)$", splash_file_name or "", re.IGNORECASE):
        fail("Splash art must be PNG, JPG, JPEG, or WebP")
    drawable = output / "app" / "src" / "main" / "res" / "drawable-nodpi"
    drawable.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / ("splash" + Path(splash_file_name).suffix.lower())
        shutil.copy2(source_path, source)
        subprocess.run([
            "convert", str(source),
            "-auto-orient",
            "-resize", "1440x2560>",
            "-background", background_hex,
            "-alpha", "remove", "-alpha", "off",
            "-strip",
            "-quality", "88",
            "JPG:" + str(drawable / "splash_art.jpg"),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return True


def write_theme(output, theme_hex, splash_hex, art_splash):
    res = output / "app" / "src" / "main" / "res"
    (res / "values" / "colors.xml").write_text(
        "<resources>\n"
        f'    <color name="launcher_background">{splash_hex}</color>\n'
        f'    <color name="theme_color">{theme_hex}</color>\n'
        f'    <color name="splash_background">{splash_hex}</color>\n'
        "</resources>\n", encoding="utf-8")
    light = "true" if is_light(theme_hex) else "false"
    base_items = (
        '        <item name="android:fontFamily">sans</item>\n'
        '        <item name="android:windowActionModeOverlay">true</item>\n'
        '        <item name="android:statusBarColor">@color/theme_color</item>\n'
        '        <item name="android:navigationBarColor">#000000</item>\n'
        f'        <item name="android:windowLightStatusBar">{light}</item>\n'
        '        <item name="android:windowBackground">@color/splash_background</item>\n'
    )
    style_open = '<resources>\n    <style name="AppTheme" parent="android:style/Theme.Material.Light.NoActionBar">\n'
    style_close = "    </style>\n</resources>\n"
    (res / "values" / "styles.xml").write_text(style_open + base_items + style_close, encoding="utf-8")
    v31 = res / "values-v31"
    v31.mkdir(parents=True, exist_ok=True)
    splash_items = '        <item name="android:windowSplashScreenBackground">@color/splash_background</item>\n'
    if art_splash:
        # Hide the system splash icon so the app's splash art appears without an icon flash first.
        splash_items += '        <item name="android:windowSplashScreenAnimatedIcon">@android:color/transparent</item>\n'
    (v31 / "styles.xml").write_text(style_open + base_items + splash_items + style_close, encoding="utf-8")
    # Night variants use a dark parent theme so pages see prefers-color-scheme: dark
    # when the phone is in dark mode, exactly like mobile Chrome.
    dark_open = style_open.replace("Theme.Material.Light.NoActionBar", "Theme.Material.NoActionBar")
    for folder, items in (("values-night", base_items), ("values-night-v31", base_items + splash_items)):
        (res / folder).mkdir(parents=True, exist_ok=True)
        (res / folder / "styles.xml").write_text(dark_open + items + style_close, encoding="utf-8")


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
    elif not os.environ.get("SOURCE_FILE"):
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

    theme_hex, theme_int = parse_color(cfg.get("themeColor"), "#080B14")
    splash_hex, splash_int = parse_color(cfg.get("splashBackground") or theme_hex, theme_hex)
    splash_file = os.environ.get("SPLASH_FILE", "")
    wants_art = str(cfg.get("splashMode", "icon")).lower() == "art"
    try:
        splash_min_ms = max(0, min(5000, int(cfg.get("splashMinMs", 600))))
    except (TypeError, ValueError):
        splash_min_ms = 600
    ua_suffix = re.sub(r"[^A-Za-z0-9 ._/()+-]", "", str(cfg.get("userAgentSuffix", "")))[:60].strip()
    cache_mode = str(cfg.get("cacheMode", "standard")).lower()
    cache_value = {"off": "WebSettings.LOAD_NO_CACHE", "standard": "WebSettings.LOAD_DEFAULT", "offline": "WebSettings.LOAD_CACHE_ELSE_NETWORK", "aggressive": "WebSettings.LOAD_CACHE_ELSE_NETWORK"}.get(cache_mode, "WebSettings.LOAD_DEFAULT")
    internal_hosts = clean_hosts(cfg.get("internalHosts", []))
    java_options = {
        "OFFLINE_STORAGE": java_bool(cfg.get("offlineStorage", False)),
        "AUTO_UPDATE": java_bool(cfg.get("autoUpdate", False)),
        "CACHE_MODE": cache_value,
        "ALLOW_EXTERNAL_LINKS": java_bool(cfg.get("externalLinks", True)),
        "ENABLE_ZOOM": java_bool(cfg.get("zoom", False)),
        "FULLSCREEN": java_bool(cfg.get("fullscreen", False)),
        "BACK_NAVIGATION": java_bool(cfg.get("backNavigation", True)),
        "PULL_TO_REFRESH": java_bool(cfg.get("pullToRefresh", False)),
        "KEEP_AWAKE": java_bool(cfg.get("keepAwake", False)),
        "ALLOW_LOCATION": java_bool(cfg.get("allowLocation", False)),
        "ALLOW_CAMERA": java_bool(cfg.get("allowCamera", False)),
        "ALLOW_MICROPHONE": java_bool(cfg.get("allowMicrophone", False)),
        "SPLASH_MODE": java_string("art" if wants_art and splash_file else "icon"),
        "SPLASH_FIT_COVER": java_bool(str(cfg.get("splashFit", "cover")).lower() != "contain"),
        "SPLASH_MIN_MS": str(splash_min_ms),
        "THEME_COLOR": theme_int,
        "SPLASH_COLOR": splash_int,
        "INTERNAL_HOSTS": "{" + ", ".join(java_string(h) for h in internal_hosts) + "}",
        "USER_AGENT_SUFFIX": java_string(ua_suffix),
    }

    java_root = output / "app" / "src" / "main" / "java"
    java_files = list(java_root.rglob("*.java"))
    target_root = java_root / package_name.replace(".", "/")
    target_root.mkdir(parents=True, exist_ok=True)
    for source in java_files:
        content = source.read_text(encoding="utf-8")
        content = re.sub(r"^package\s+[^;]+;", f"package {package_name};", content, count=1, flags=re.MULTILINE)
        # Local sites are served from the host root, like a normal web host.
        target_url = source_url if web_source else "https://appassets.androidplatform.net/"
        java_url = target_url.replace("\\", "\\\\").replace('"', '\\"')
        content = content.replace("__TARGET_URL__", java_url)
        if source.name == "MainActivity.java":
            for option_name, option_value in java_options.items():
                content = set_option(content, option_name, option_value)
        source.write_text(content, encoding="utf-8")
        target = target_root / source.name
        if source.resolve() != target.resolve():
            shutil.move(str(source), str(target))
    for directory in sorted([p for p in java_root.rglob("*") if p.is_dir()], reverse=True):
        try:
            directory.rmdir()
        except OSError:
            pass

    install_app_icon(os.environ.get("ICON_FILE", ""), str(cfg.get("iconFileName", "")), output)
    art_installed = wants_art and install_splash_art(splash_file, str(cfg.get("splashFileName", "")), splash_hex, output)
    if wants_art and not art_installed:
        # Keep the Java option consistent with what was actually installed.
        main_java = next((output / "app" / "src" / "main" / "java").rglob("MainActivity.java"))
        main_java.write_text(set_option(main_java.read_text(encoding="utf-8"), "SPLASH_MODE", java_string("icon")), encoding="utf-8")
    write_theme(output, theme_hex, splash_hex, art_installed)

    manifest = output / "app" / "src" / "main" / "AndroidManifest.xml"
    manifest_text = manifest.read_text(encoding="utf-8")
    escaped_name = name.replace("&", "&amp;").replace('"', "&quot;")
    manifest_text = re.sub(r'android:label="[^"]*"', f'android:label="{escaped_name}"', manifest_text, count=1)
    orientation = str(cfg.get("orientation", "unspecified"))
    if orientation not in {"unspecified", "portrait", "landscape", "sensor", "fullSensor"}:
        fail("Invalid orientation")
    manifest_text = re.sub(r'android:screenOrientation="[^"]*"', f'android:screenOrientation="{orientation}"', manifest_text, count=1)
    extra_permissions = []
    if cfg.get("allowCamera"):
        extra_permissions.append("android.permission.CAMERA")
    if cfg.get("allowMicrophone"):
        extra_permissions += ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"]
    if cfg.get("allowLocation"):
        extra_permissions += ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"]
    if extra_permissions:
        lines = "\n".join(f'    <uses-permission android:name="{p}" />' for p in extra_permissions)
        manifest_text = re.sub(r"    <!-- OPTIONAL_PERMISSIONS:[^>]*-->", lines, manifest_text, count=1)
    if cfg.get("allowCamera"):
        manifest_text = manifest_text.replace("    <application", '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <application', 1)
    if cfg.get("allowCleartext") or (web_source and source_url.lower().startswith("http://")):
        # Plain-http websites are blocked by Android unless cleartext is allowed.
        manifest_text = manifest_text.replace("<application", '<application\n        android:usesCleartextTraffic="true"', 1)
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
    # Never ship template web assets. Website builds load the supplied URL directly;
    # local HTML/ZIP builds repopulate this directory from the uploaded source below.
    for child in list(assets.iterdir()):
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()

    if not web_source:
        source_file = Path(os.environ["SOURCE_FILE"])
        if not source_file.is_file():
            fail("Uploaded HTML/ZIP source file is missing")
        raw = source_file.read_bytes()
        source_name = str(cfg.get("sourceFileName", source_file.name)).lower().strip()
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
