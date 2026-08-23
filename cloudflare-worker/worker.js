const ORIGIN = "https://factory.castelmei.com";
const API_VERSION = "2022-11-28";
const MAX_SOURCE_BASE64 = 28_000_000;
const CHUNK_CHARS = 800_000; // divisible by 4; each chunk is independently valid base64

function headers() {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}
function reply(data, status=200) { return new Response(JSON.stringify(data), {status, headers: headers()}); }
function validPkg(v) { return typeof v === "string" && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(v); }
function validHttps(v) { try { return new URL(v).protocol === "https:"; } catch { return false; } }
function b64utf8(text) {
  const bytes = new TextEncoder().encode(text); let out = "";
  for (let i=0;i<bytes.length;i+=0x8000) out += String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(out);
}
async function gh(env, path, options={}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "castel-app-factory-api",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${data?.message || text || "request failed"}`);
  return data;
}
function repoPath(env, p) { return `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${p}`; }
async function putFile(env, path, contentBase64, message) {
  return gh(env, repoPath(env, path), {method:"PUT", body:JSON.stringify({message,content:contentBase64,branch:"main"})});
}
async function getFile(env, path) { return gh(env, repoPath(env, path) + "?ref=main"); }

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:headers()});
    if (u.pathname === "/health" && request.method === "GET") {
      return reply({ok:true,service:"Castel App Factory API",status:"online",repo:`${env.GITHUB_OWNER || ""}/${env.GITHUB_REPO || ""}`});
    }
    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) return reply({ok:false,error:"Build bridge is not configured."},503);

    if (u.pathname === "/build" && request.method === "POST") {
      try {
        const b = await request.json();
        const sourceType = b.sourceType === "HTTPS website" || b.sourceType === "website" ? "website" : "html";
        const appName = String(b.appName || "").trim();
        const packageName = String(b.packageName || "").trim();
        const versionName = String(b.versionName || "").trim();
        const versionCode = Number(b.versionCode);
        const websiteUrl = String(b.sourceUrl || b.websiteUrl || "").trim();
        const sourceFileName = String(b.sourceFileName || "").trim();
        const sourceBase64 = String(b.sourceBase64 || "");
        if (!appName || appName.length > 40) return reply({ok:false,error:"Invalid app name."},400);
        if (!validPkg(packageName)) return reply({ok:false,error:"Invalid Android package ID."},400);
        if (!/^\d+(\.\d+){0,2}$/.test(versionName)) return reply({ok:false,error:"Invalid version name."},400);
        if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) return reply({ok:false,error:"Invalid version code."},400);
        if (sourceType === "website" && !validHttps(websiteUrl)) return reply({ok:false,error:"Website source must be HTTPS."},400);
        if (sourceType === "html" && !sourceBase64) return reply({ok:false,error:"HTML/ZIP source is missing."},400);
        if (sourceBase64.length > MAX_SOURCE_BASE64) return reply({ok:false,error:"Uploaded source is too large for this build bridge. Use a ZIP under about 21 MB for now."},413);
        if (sourceBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(sourceBase64)) return reply({ok:false,error:"Uploaded source encoding is invalid."},400);

        const buildId = crypto.randomUUID();
        const base = `build-inputs/${buildId}`;
        const chunks = [];
        if (sourceBase64) {
          for (let i=0;i<sourceBase64.length;i+=CHUNK_CHARS) chunks.push(sourceBase64.slice(i,i+CHUNK_CHARS));
        }
        const manifest = {
          buildId, appName, packageName, versionName, versionCode,
          orientation: b.orientation || "unspecified",
          sourceType: sourceType === "website" ? "HTTPS website" : (sourceFileName.toLowerCase().endsWith(".zip") ? "Uploaded HTML/ZIP" : "Uploaded HTML"),
          sourceFileName, sourceUrl: websiteUrl,
          backNavigation: Boolean(b.backNavigation), zoom: Boolean(b.zoom), fullscreen: Boolean(b.fullscreen), externalLinks: Boolean(b.externalLinks),
          sourceChunkCount: chunks.length, createdAt: new Date().toISOString()
        };
        await putFile(env, `${base}/manifest.json`, b64utf8(JSON.stringify(manifest,null,2)), `Queue build ${buildId} manifest`);
        await putFile(env, `${base}/status.json`, b64utf8(JSON.stringify({buildId,status:"queued",updatedAt:new Date().toISOString()})), `Queue build ${buildId} status`);
        for (let i=0;i<chunks.length;i++) {
          const name = `source-${String(i).padStart(4,"0")}.bin`;
          await putFile(env, `${base}/${name}`, chunks[i], `Queue build ${buildId} source ${i+1}/${chunks.length}`);
        }
        const workflow = env.GITHUB_WORKFLOW || "build-app.yml";
        const dispatch = await gh(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
          method:"POST", body:JSON.stringify({ref:"main",inputs:{build_id:buildId}})
        });
        return reply({ok:true,status:"queued",buildId,runId:dispatch?.workflow_run_id || null,runUrl:dispatch?.run_url || `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions`,message:"Build queued in GitHub Actions."},202);
      } catch (e) { console.error(e); return reply({ok:false,error:e.message || "Build request failed."},502); }
    }

    const match = u.pathname.match(/^\/build\/([0-9a-f-]{36})$/i);
    if (match && request.method === "GET") {
      try {
        const id = match[1]; const f = await getFile(env, `build-inputs/${id}/status.json`);
        const raw = atob(String(f.content || "").replace(/\n/g,""));
        const bytes = Uint8Array.from(raw,c=>c.charCodeAt(0));
        return reply(JSON.parse(new TextDecoder().decode(bytes)));
      } catch (e) { return reply({ok:false,error:"Build ID not found or status unavailable."},404); }
    }
    return reply({ok:false,error:"Endpoint not found."},404);
  }
};
