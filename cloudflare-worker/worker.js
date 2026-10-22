// Optional AI supervision is advisory. Keep the Worker self-contained so a
// missing optional module can never block production deployment.
// Deployment marker: website-source-v3 bridge.
// Production bridge deployment smoke trigger: 2026-09-27.
async function superviseBuild(env, context = {}) {
  if (!env?.OPENAI_API_KEY) return { enabled: false, reason: "OPENAI_API_KEY is not configured" };
  return { enabled: true, model: "configured-supervisor", reason: `Advisory supervision enabled for ${String(context.sourceType || "unknown")}` };
}

import { handleMaster, isOwner, isOwnerSession, configStatus, adminIssue, adminRevoke } from "./owner.js";
import { claimPlayPurchase } from "./play.js";
import { plansPayload, createCheckout, claimCheckout, verifyLicense, resolveTier, premiumFeaturesUsed, tierRank, verifyWebhook, sessionForReference, freeBuildAllowed, PLAN_INFO } from "./billing.js";

const ORIGIN = "https://create.instapped.com";
const API_VERSION = "2022-11-28";
const MAX_SOURCE_BASE64 = 28_000_000;
const MAX_ICON_BASE64 = 8_000_000;
const MAX_SPLASH_BASE64 = 11_000_000;
const CHUNK_CHARS = 800_000;
// Re-deploy to verify the live GitHub and signing secret configuration.
const BUILD_BRIDGE_REVISION = "instapped-editions-v1";
const SIGNING_ACCESS_HEADER = "X-Castel-Signing-Access";

async function signingTokenMatches(candidate, expected) {
  const a = new TextEncoder().encode(String(candidate || ""));
  const b = new TextEncoder().encode(String(expected || ""));
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
function headers() {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
}
function reply(data, status=200) { return new Response(JSON.stringify(data), {status, headers: headers()}); }
function validPkg(v) { return typeof v === "string" && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(v); }
function normalizeWebsiteUrl(v) { try { let raw=String(v||"").trim(); if (!raw) return null; if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw=`https://${raw}`; const u=new URL(raw); return (u.protocol === "https:" || u.protocol === "http:") ? u.href : null; } catch { return null; } }
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
      "User-Agent": "instapped-api",
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
async function putFile(env, path, contentBase64, message, branch="main") {
  return gh(env, repoPath(env, path), {method:"PUT", body:JSON.stringify({message,content:contentBase64,branch})});
}
async function getFile(env, path, ref="main") { return gh(env, repoPath(env, path) + "?ref=" + encodeURIComponent(ref)); }

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null,{status:204,headers:headers()});
    if (u.pathname === "/health" && request.method === "GET") {
      return reply({ok:true,service:"instApped API",status:"online",revision:BUILD_BRIDGE_REVISION,repo:`${env.GITHUB_OWNER || "castelnoleal"}/${env.GITHUB_REPO || "instApped"}`,githubConfigured: Boolean(env.GITHUB_TOKEN && (env.GITHUB_OWNER || "castelnoleal") && (env.GITHUB_REPO || "instApped")),signingConfigured: Boolean(env.CASTEL_SIGNING_ACCESS_TOKEN),aiSupervisor: Boolean(env.OPENAI_API_KEY)});
    }
    // ---------------- owner-only master edition (mirrors factory/index.html on main)
    const master = await handleMaster(request, env, async () => {
      if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
      const f = await getFile(env, "factory/index.html", "main");
      const raw = atob(String(f.content || "").replace(/\n/g, ""));
      return new TextDecoder().decode(Uint8Array.from(raw, c => c.charCodeAt(0)));
    });
    if (master) return master;
    if (u.pathname.startsWith("/admin/")) {
      const b = request.method === "POST" ? await request.json().catch(() => ({})) : {};
      if (!(await isOwner(env, request, b.ownerToken || request.headers.get(SIGNING_ACCESS_HEADER)))) return reply({ ok: false, error: "Owner access only." }, 401);
      try {
        if (u.pathname === "/admin/status" && request.method === "GET") return reply({ ok: true, revision: BUILD_BRIDGE_REVISION, config: configStatus(env) });
        if (u.pathname === "/admin/license" && request.method === "POST") return reply({ ok: true, ...(await adminIssue(env, b)) });
        if (u.pathname === "/admin/revoke" && request.method === "POST") return reply({ ok: true, ...(await adminRevoke(env, b)) });
      } catch (e) { return reply({ ok: false, error: e.message || "Owner action failed." }, e.status || 500); }
      return reply({ ok: false, error: "Endpoint not found." }, 404);
    }
    if (u.pathname === "/license/play" && request.method === "POST") {
      try {
        const b = await request.json().catch(() => ({}));
        const out = await claimPlayPurchase(env, b);
        return reply(out, out.ok ? 200 : 409);
      } catch (e) { return reply({ ok: false, error: e.message || "Couldn't confirm the Google Play purchase." }, e.status && (e.status < 500 || e.status === 503) ? e.status : 502); }
    }

    // ---------------- plans, checkout and licenses (no GitHub token needed)
    if (u.pathname === "/plans" && request.method === "GET") return reply(plansPayload(env));
    if (u.pathname === "/checkout" && request.method === "POST") {
      try {
        const b = await request.json().catch(() => ({}));
        const out = await createCheckout(env, { plan: String(b.plan || ""), period: String(b.period || ""), email: b.email, factoryUrl: env.FACTORY_URL || ORIGIN });
        return reply({ ok: true, ...out });
      } catch (e) { return reply({ ok: false, error: e.message || "Checkout failed." }, e.status && (e.status < 500 || e.status === 503) ? e.status : 502); }
    }
    if ((u.pathname === "/license/claim" || u.pathname === "/license/recover") && request.method === "POST") {
      try {
        const b = await request.json().catch(() => ({}));
        const sessionId = u.pathname === "/license/recover" ? await sessionForReference(env, b.reference) : String(b.sessionId || "");
        if (!sessionId) return reply({ ok: false, error: "We couldn't find a purchase with that reference. Use the checkout ID (starts with cs_) from your purchase, or contact support." }, 404);
        const out = await claimCheckout(env, { sessionId, currentKey: b.currentKey });
        return reply(out, out.ok ? 200 : out.pending ? 202 : 409);
      } catch (e) { return reply({ ok: false, error: e.message || "Couldn't confirm the payment." }, e.status && (e.status < 500 || e.status === 503) ? e.status : 502); }
    }
    if (u.pathname === "/license/verify" && request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      const owner = await isOwner(env, request, b.ownerToken);
      if (owner) return reply({ ok: true, valid: true, plan: "business", owner: true });
      const v = await verifyLicense(env.LICENSE_SECRET, b.key);
      if (v.valid && v.ref && env.LICENSES) {
        try { if (await env.LICENSES.get("revoked:" + v.ref)) return reply({ ok: true, valid: false, plan: "free", exp: null, expired: false, revoked: true, reason: "This license was revoked. Contact support.", name: "Free" }); } catch {}
      }
      return reply({ ok: true, valid: v.valid, plan: v.plan || "free", exp: v.exp || null, expired: Boolean(v.expired), reason: v.valid ? "" : v.reason, name: v.plan ? PLAN_INFO[v.plan].name : "Free" });
    }
    if (u.pathname === "/webhooks/paymongo" && request.method === "POST") {
      const raw = await request.text();
      if (!(await verifyWebhook(env.PAYMONGO_WEBHOOK_SECRET, request.headers.get("Paymongo-Signature"), raw))) return reply({ ok: false, error: "Invalid signature." }, 401);
      try {
        const event = JSON.parse(raw);
        const type = event?.data?.attributes?.type;
        const sessionId = event?.data?.attributes?.data?.id;
        // Issue and store the key as soon as PayMongo confirms, so it can be recovered later.
        if (type === "checkout_session.payment.paid" && /^cs_/.test(String(sessionId || ""))) await claimCheckout(env, { sessionId });
      } catch (e) { console.error("webhook", e); }
      return reply({ ok: true });
    }

    if (!env.GITHUB_TOKEN) return reply({ok:false,error:"Build bridge GitHub token is not configured. Add the GITHUB_TOKEN Worker secret."},503);

    const downloadMatch = u.pathname.match(/^\/download\/([0-9a-f-]{36})\/(apk|aab)$/i);
    if (downloadMatch && request.method === "GET") {
      try {
        const buildId = downloadMatch[1];
        const kind = downloadMatch[2].toLowerCase();
        const owner = env.GITHUB_OWNER || "castelnoleal";
        const repo = env.GITHUB_REPO || "instApped";
        // Use the authenticated GitHub API: browser_download_url can return 403
        // when the repository/release is private, even though the Worker has access.
        const release = await gh(env, `/repos/${owner}/${repo}/releases/tags/build-${buildId}`);
        const extension = kind === "apk" ? ".apk" : ".aab";
        const asset = (release.assets || []).find(item => String(item.name || "").toLowerCase().endsWith(extension));
        if (!asset) return reply({ok:false,error:`The ${kind.toUpperCase()} file was not found in this build release.`}, 404);
        const fileName = asset.name;
        const upstream = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/assets/${asset.id}`, {
          method: "GET",
          redirect: "follow",
          headers: { "Accept": "application/octet-stream", "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": API_VERSION, "User-Agent": "instapped-download" }
        });
        if (!upstream.ok) return reply({ok:false,error:`Artifact download returned HTTP ${upstream.status}.`}, upstream.status);
        const outHeaders = new Headers();
        // File responses need the same CORS permission as JSON responses; otherwise
        // fetch() from the factory/WebView fails before it can create a download.
        outHeaders.set("Access-Control-Allow-Origin", ORIGIN);
        outHeaders.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        outHeaders.set("Access-Control-Allow-Headers", "Content-Type");
        outHeaders.set("Access-Control-Expose-Headers", "Content-Disposition, Content-Length");
        outHeaders.set("Vary", "Origin");
        outHeaders.set("Content-Type", kind === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream");
        outHeaders.set("Content-Disposition", `attachment; filename="${fileName.replace(/["\\\\\\r\\n]/g, "_")}"`);
        outHeaders.set("Cache-Control", "private, no-store");
        const length = upstream.headers.get("Content-Length");
        if (length) outHeaders.set("Content-Length", length);
        return new Response(upstream.body, {status: 200, headers: outHeaders});
      } catch (e) {
        return reply({ok:false,error:e.message || "Artifact download failed."}, 502);
      }
    }

    if (u.pathname === "/build" && request.method === "POST") {
      try {
        const b = await request.json();
        const declaredSource = String(b.sourceMode || b.sourceType || "").toLowerCase().trim();
        const websiteKinds = new Set(["website","website url","https website","https website url","http website","http website url","web","url"]);
        const rawWebsiteUrl = b.sourceUrl || b.websiteUrl || "";
        const normalizedWebsiteUrl = normalizeWebsiteUrl(rawWebsiteUrl);
        const sourceType = websiteKinds.has(declaredSource) || (!b.sourceBase64 && !!normalizedWebsiteUrl) ? "website" : "html";
        const appName = String(b.appName || "").trim();
        const packageName = String(b.packageName || "").trim();
        const versionName = String(b.versionName || "").trim();
        const versionCode = Number(b.versionCode);
        const websiteUrl = normalizedWebsiteUrl;
        const sourceFileName = String(b.sourceFileName || "").trim();
        const sourceBase64 = String(b.sourceBase64 || "");
        const iconBase64 = String(b.iconBase64 || "");
        const iconFileName = String(b.iconFileName || "").trim();
        const splashBase64 = String(b.splashBase64 || "");
        const splashFileName = String(b.splashFileName || "").trim();
        const hexColor = (v, d) => /^#[0-9a-f]{6}$/i.test(String(v || "").trim()) ? String(v).trim() : d;
        const themeColor = hexColor(b.themeColor, "#080B14");
        const splashBackground = hexColor(b.splashBackground, themeColor);
        const splashMode = String(b.splashMode || "").toLowerCase() === "art" && splashBase64 ? "art" : "icon";
        const splashFit = String(b.splashFit || "").toLowerCase() === "contain" ? "contain" : "cover";
        const splashMinMs = Math.max(0, Math.min(5000, Math.round(Number(b.splashMinMs ?? 600)) || 0));
        const internalHosts = (Array.isArray(b.internalHosts) ? b.internalHosts : String(b.internalHosts || "").split(","))
          .map(h => String(h).trim().toLowerCase()).filter(h => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)).slice(0, 20);
        const updateFeedUrl = /^https:\/\/[^\s"\\]+$/i.test(String(b.updateFeedUrl || "").trim()) ? String(b.updateFeedUrl).trim() : "";
        const updateCheckHours = Math.max(1, Math.min(168, Math.round(Number(b.updateCheckHours ?? 12)) || 12));
        const userAgentSuffix = String(b.userAgentSuffix || "").replace(/[^A-Za-z0-9 ._\/()+-]/g, "").trim().slice(0, 60);
        const testBuild = Boolean(b.testBuild);
        const projectId = String(b.projectId || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0,80);
        const previousBuildId = String(b.previousBuildId || "").trim();
        const signingRequested = Boolean(b.signing);
        const signingAccess = String(b.signingAccessToken || request.headers.get(SIGNING_ACCESS_HEADER) || "");
        // Plan enforcement happens here, on the server, so it can't be skipped from the page.
        const tierInfo = (await isOwnerSession(env, request)) ? { tier: "business", owner: true }
          : await resolveTier(env, { licenseKey: String(b.licenseKey || request.headers.get("X-Instapped-License") || ""), ownerToken: signingAccess });
        const tier = tierInfo.tier;
        // Test builds publish to the shared test release, so only the owner may request them.
        if (testBuild && !tierInfo.owner) return reply({ok:false,error:"Test builds are reserved for the factory owner."},403);
        if (!appName || appName.length > 40) return reply({ok:false,error:"Invalid app name."},400);
        if (!validPkg(packageName)) return reply({ok:false,error:"Invalid Android package ID."},400);
        if (!/^\d+(\.\d+){0,2}$/.test(versionName)) return reply({ok:false,error:"Invalid version name."},400);
        if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2100000000) return reply({ok:false,error:"Invalid version code."},400);
        if (sourceType === "website" && !websiteUrl) return reply({ok:false,error:"Website source must be a valid HTTP or HTTPS URL."},400);
        if (sourceType === "html" && !sourceBase64) return reply({ok:false,error:"HTML/ZIP source is missing."},400);
        if (sourceBase64.length > MAX_SOURCE_BASE64) return reply({ok:false,error:"Uploaded source is too large for this build bridge. Use a ZIP under about 21 MB for now."},413);
        if (iconBase64.length > MAX_ICON_BASE64) return reply({ok:false,error:"App icon is too large. Use an image under about 6 MB."},413);
        if (sourceBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(sourceBase64)) return reply({ok:false,error:"Uploaded source encoding is invalid."},400);
        if (iconBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(iconBase64)) return reply({ok:false,error:"App icon encoding is invalid."},400);
        if (iconBase64 && !/\.(png|jpe?g|webp)$/i.test(iconFileName)) return reply({ok:false,error:"App icon must be PNG, JPG, JPEG, or WebP."},400);
        if (splashBase64.length > MAX_SPLASH_BASE64) return reply({ok:false,error:"Splash art is too large. Use an image under about 8 MB."},413);
        if (splashBase64 && !/^[A-Za-z0-9+/]*={0,2}$/.test(splashBase64)) return reply({ok:false,error:"Splash art encoding is invalid."},400);
        if (splashBase64 && !/\.(png|jpe?g|webp)$/i.test(splashFileName)) return reply({ok:false,error:"Splash art must be PNG, JPG, JPEG, or WebP."},400);
        const premiumUsed = premiumFeaturesUsed({ signing: signingRequested, splashMode, themeColor, splashBackground, updateAlerts: Boolean(b.updateAlerts), pageNotifications: Boolean(b.pageNotifications), playBilling: Boolean(b.playBilling) });
        const blocked = premiumUsed.filter(f => tierRank(tier) < tierRank(f.minTier));
        if (blocked.length) {
          const labels = blocked.map(f => f.label);
          const requiredPlan = blocked.some(f => f.minTier === "business") ? "business" : "pro";
          return reply({ok:false, code:"upgrade_required", requiredPlan, tier, features:labels, licenseError: tierInfo.licenseError || "",
            error: `${labels.join(", ")} ${labels.length > 1 ? "need" : "needs"} instApped ${requiredPlan === "business" ? "Business" : "Pro"}.${tierInfo.licenseError ? " " + tierInfo.licenseError : " Add a license key in Settings."}`}, 402);
        }
        const signing = signingRequested;
        if (tier === "free") {
          const quota = await freeBuildAllowed(env, request.headers.get("CF-Connecting-IP") || "unknown");
          if (!quota.allowed) return reply({ok:false, code:"free_limit", tier, error:`The free plan includes ${quota.limit} builds a day. Try again tomorrow, or use a Pro license for unlimited builds.`}, 429);
        }
        const ai = await superviseBuild(env, {sourceType: sourceType === "website" ? "HTTPS website" : (sourceFileName.toLowerCase().endsWith(".zip") ? "Uploaded HTML/ZIP" : "Uploaded HTML"), sourceUrl: websiteUrl, sourceFileName, appName, packageName, versionName, versionCode, orientation: b.orientation || "unspecified", backNavigation: Boolean(b.backNavigation), zoom: Boolean(b.zoom), fullscreen: Boolean(b.fullscreen), externalLinks: Boolean(b.externalLinks)});
        const buildId = crypto.randomUUID();
        const base = `build-inputs/${buildId}`;
        const buildBranch = `build-${buildId}`;
        const mainRef = await gh(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/ref/heads/main`);
        await gh(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/git/refs`, {method:"POST", body:JSON.stringify({ref:`refs/heads/${buildBranch}`, sha:mainRef.object.sha})});
        const chunks = [];
        if (sourceBase64) for (let i=0;i<sourceBase64.length;i+=CHUNK_CHARS) chunks.push(sourceBase64.slice(i,i+CHUNK_CHARS));
        const iconChunks = [];
        if (iconBase64) for (let i=0;i<iconBase64.length;i+=CHUNK_CHARS) iconChunks.push(iconBase64.slice(i,i+CHUNK_CHARS));
        const splashChunks = [];
        if (splashMode === "art") for (let i=0;i<splashBase64.length;i+=CHUNK_CHARS) splashChunks.push(splashBase64.slice(i,i+CHUNK_CHARS));
        const manifest = {buildId, projectId, previousBuildId: /^[0-9a-f-]{36}$/i.test(previousBuildId) ? previousBuildId : "", appName, packageName, versionName, versionCode, sourceMode: sourceType, orientation: b.orientation || "unspecified", sourceType: sourceType === "website" ? "HTTPS website" : (sourceFileName.toLowerCase().endsWith(".zip") ? "Uploaded HTML/ZIP" : "Uploaded HTML"), sourceFileName, sourceUrl: websiteUrl, backNavigation: Boolean(b.backNavigation), zoom: Boolean(b.zoom), fullscreen: Boolean(b.fullscreen), externalLinks: Boolean(b.externalLinks), offlineStorage: Boolean(b.offlineStorage), autoUpdate: Boolean(b.autoUpdate), cacheMode: ["off","standard","offline","aggressive"].includes(String(b.cacheMode || "standard").toLowerCase()) ? String(b.cacheMode || "standard").toLowerCase() : "standard", signing, sourceChunkCount: chunks.length, iconChunkCount: iconChunks.length, iconFileName, splashChunkCount: splashChunks.length, splashFileName: splashMode === "art" ? splashFileName : "", splashMode, splashFit, splashMinMs, splashBackground, themeColor, tier, brandBadge: tier === "free", pullToRefresh: Boolean(b.pullToRefresh), keepAwake: Boolean(b.keepAwake), allowLocation: Boolean(b.allowLocation), allowCamera: Boolean(b.allowCamera), allowMicrophone: Boolean(b.allowMicrophone), allowCleartext: Boolean(b.allowCleartext), updateAlerts: Boolean(b.updateAlerts), playUpdates: b.playUpdates !== false, updateFeedUrl, updateCheckHours, pageNotifications: Boolean(b.pageNotifications), playBilling: Boolean(b.playBilling), internalHosts, userAgentSuffix, testBuild, aiSupervisor: ai.enabled ? {enabled:true,model:ai.model,reason:ai.reason} : {enabled:false,reason:ai.reason}, createdAt: new Date().toISOString()};
        await putFile(env, `${base}/manifest.json`, b64utf8(JSON.stringify(manifest,null,2)), `Queue build ${buildId} manifest`, buildBranch);
        await putFile(env, `${base}/status.json`, b64utf8(JSON.stringify({buildId,status:"queued",testBuild,aiSupervisor:manifest.aiSupervisor,updatedAt:new Date().toISOString()})), `Queue build ${buildId} status`, buildBranch);
        for (let i=0;i<chunks.length;i++) await putFile(env, `${base}/source-${String(i).padStart(4,"0")}.bin`, chunks[i], `Queue build ${buildId} source ${i+1}/${chunks.length}`, buildBranch);
        for (let i=0;i<iconChunks.length;i++) await putFile(env, `${base}/icon-${String(i).padStart(4,"0")}.bin`, iconChunks[i], `Queue build ${buildId} icon ${i+1}/${iconChunks.length}`, buildBranch);
        for (let i=0;i<splashChunks.length;i++) await putFile(env, `${base}/splash-${String(i).padStart(4,"0")}.bin`, splashChunks[i], `Queue build ${buildId} splash ${i+1}/${splashChunks.length}`, buildBranch);
        const workflow = env.GITHUB_WORKFLOW || "build-app.yml";
        await gh(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {method:"POST",body:JSON.stringify({ref:buildBranch,inputs:{build_id:buildId}})});
        return reply({ok:true,status:"queued",revision:BUILD_BRIDGE_REVISION,sourceType,buildId,testBuild,signing,tier,aiSupervisor:manifest.aiSupervisor,runUrl:`https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions`,message:"Build queued in GitHub Actions.",queueMode:"isolated-concurrent"},202);
      } catch (e) { console.error(e); return reply({ok:false,error:e.message || "Build request failed."},502); }
    }
    const match = u.pathname.match(/^\/build\/([0-9a-f-]{36})$/i);
    if (match && request.method === "GET") {
      const id = match[1];
      try {
        const f = await getFile(env, `build-inputs/${id}/status.json`, `build-${id}`);
        const raw = atob(String(f.content || "").replace(/\n/g,""));
        const bytes = Uint8Array.from(raw,c=>c.charCodeAt(0));
        const status = JSON.parse(new TextDecoder().decode(bytes));
        // GitHub Actions is authoritative; recover from a stale/intermediate failure status.
        if (status.status === "failed" && status.runId) {
          try {
            const run = await gh(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${status.runId}`);
            if (run.status !== "completed") return reply({...status,status:"running",message:"Verifying build result with GitHub Actions",progress:status.progress || 90});
            if (run.conclusion === "success") {
              const rr = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/build-${id}`, {headers:{Accept:"application/vnd.github+json","User-Agent":"instapped-api","X-GitHub-Api-Version":API_VERSION}});
              if (rr.ok) {
                const release = await rr.json();
                const apk = (release.assets || []).find(a => String(a.name || "").toLowerCase().endsWith(".apk"));
                const aab = (release.assets || []).find(a => String(a.name || "").toLowerCase().endsWith(".aab"));
                if (apk || aab) return reply({...status,status:"success",runUrl:run.html_url || status.runUrl,buildApkUrl:`https://${u.host}/download/${id}/apk`,buildAabUrl:`https://${u.host}/download/${id}/aab`,apk:apk?.name,aab:aab?.name,message:"Build succeeded; result recovered from GitHub Actions."});
              }
            }
            if (run.status === "completed" && run.conclusion !== "success") return reply({...status,status:"failed",error:status.error || `GitHub Actions concluded: ${run.conclusion || "failure"}.`,runUrl:run.html_url || status.runUrl});
          } catch (verifyError) { return reply({...status,status:"running",message:"Reconnecting to verify the build result",progress:status.progress || 90}); }
        }
        return reply(status);
      } catch (e) {
        const message = String(e?.message || "");
        const notFound = /GitHub 404: Not Found|Not Found/.test(message);
        return reply({ok:false,error:notFound ? "Build ID not found." : "Build status temporarily unavailable; retry the request."},notFound ? 404 : 503);
      }
    }
    return reply({ok:false,error:"Endpoint not found."},404);
  }
};
