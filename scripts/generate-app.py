import json, os, re, shutil, base64, zipfile
from pathlib import Path

root=Path(__file__).resolve().parents[1]
manifest_path=Path(os.environ['BUILD_MANIFEST'])
out=Path(os.environ.get('BUILD_OUTPUT','generated-app'))
template=root/'android-template'

cfg=json.loads(manifest_path.read_text())
name=cfg['appName'].strip()
pkg=cfg['packageName'].strip()
version=str(cfg['versionName']).strip()
code=int(cfg['versionCode'])
source_type=cfg.get('sourceType','Uploaded HTML/ZIP')
source_url=cfg.get('sourceUrl') or cfg.get('url') or ''

if not re.fullmatch(r'[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+',pkg): raise SystemExit('Invalid package name')
if not re.fullmatch(r'\d+(\.\d+){0,2}',version): raise SystemExit('Invalid version')
if code<1: raise SystemExit('Invalid version code')

if out.exists(): shutil.rmtree(out)
shutil.copytree(template,out)
for p in [out/'.gradle',out/'build',out/'app'/'build']:
    if p.exists(): shutil.rmtree(p)

g=out/'app'/'build.gradle'
s=g.read_text()
s=re.sub(r"namespace '.*?'",f"namespace '{pkg}'",s)
s=re.sub(r"applicationId '.*?'",f"applicationId '{pkg}'",s)
s=re.sub(r"versionCode \d+",f"versionCode {code}",s)
s=re.sub(r"versionName '.*?'",f"versionName '{version}'",s)
g.write_text(s)

java_root=out/'app'/'src'/'main'/'java'
for p in list(java_root.rglob('*.java')):
    txt=p.read_text()
    txt=re.sub(r'^package\s+[^;]+;',f'package {pkg};',txt,count=1,flags=re.M)
    if source_url and (source_type.lower().startswith('https') or source_type.lower().startswith('website')):
        java_url=json.dumps(source_url)
        txt=re.sub(r'webView\.loadUrl\("[^"]*"\);',f'webView.loadUrl({java_url});',txt)
    p.write_text(txt)
    target=java_root/pkg.replace('.','/')/p.name
    target.parent.mkdir(parents=True,exist_ok=True)
    shutil.move(str(p),str(target))
for d in sorted([x for x in java_root.rglob('*') if x.is_dir()],reverse=True):
    try: d.rmdir()
    except OSError: pass

manifest=out/'app'/'src'/'main'/'AndroidManifest.xml'
if manifest.exists():
    ms=manifest.read_text()
    label=xml_name=name.replace('&','&amp;').replace('"','&quot;')
    ms=re.sub(r'android:label="[^"]*"',f'android:label="{label}"',ms)
    orientation=cfg.get('orientation','unspecified')
    if 'android:screenOrientation=' in ms:
        ms=re.sub(r'android:screenOrientation="[^"]*"',f'android:screenOrientation="{orientation}"',ms)
    elif orientation!='unspecified':
        ms=ms.replace('android:exported="true"',f'android:screenOrientation="{orientation}" android:exported="true"')
    manifest.write_text(ms)

settings=out/'settings.gradle'
if settings.exists():
    project_name=re.sub(r'[^A-Za-z0-9_-]','_',name)
    ss=settings.read_text(); ss=re.sub(r"rootProject\.name\s*=\s*'.*?'",f"rootProject.name = '{project_name}'",ss); settings.write_text(ss)

assets=out/'app'/'src'/'main'/'assets'
assets.mkdir(parents=True,exist_ok=True)
source_b64=os.environ.get('SOURCE_BASE64','')
if source_b64:
    raw=base64.b64decode(source_b64)
    if source_type.lower().endswith('zip') or cfg.get('sourceFileName','').lower().endswith('.zip'):
        tmp=out/'_source.zip'; tmp.write_bytes(raw)
        with zipfile.ZipFile(tmp) as z: z.extractall(assets)
        tmp.unlink()
    else:
        (assets/'index.html').write_bytes(raw)
elif not source_type.lower().startswith('https') and not source_url:
    (assets/'index.html').write_text('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Castel App Factory</h1><p>Generated application.</p></body></html>')

if not source_type.lower().startswith('https') and not (assets/'index.html').exists():
    candidates=list(assets.rglob('index.html'))
    if candidates: shutil.copy2(candidates[0],assets/'index.html')
    else: raise SystemExit('No index.html found in uploaded source')

print(f'Generated {name} ({pkg}) at {out}')
