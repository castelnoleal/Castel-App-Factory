// Owner tool: list the apps built by instApped and delete old builds.
// A build is its GitHub release (build-<id>, holding the APK/AAB), its git tag, its
// build branch (build-<id>, holding the uploaded source) and its Actions artifact.
// Nothing is deleted unless the owner picks the builds and confirms in Owner tools.

const PAGE = 20;      // releases per listing request (keeps GitHub subrequests per call low)
const DELETE_MAX = 6; // builds per delete request

const err = (message, status) => Object.assign(new Error(message), { status });
const isBuildId = (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));

function decodeContent(c) {
  const raw = atob(String(c || "").replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(raw, (ch) => ch.charCodeAt(0)));
}

/** App details for a build, from its manifest (cached in KV, since manifests never change). */
async function buildInfo(env, gh, id) {
  const key = "buildinfo:" + id;
  if (env.LICENSES) { try { const hit = await env.LICENSES.get(key); if (hit) return JSON.parse(hit); } catch {} }
  let info = { packageName: "", appName: "", versionName: "", versionCode: 0, testBuild: false, source: "" };
  try {
    const f = await gh(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/build-inputs/${id}/manifest.json?ref=${encodeURIComponent("build-" + id)}`);
    const m = JSON.parse(decodeContent(f.content));
    info = { packageName: String(m.packageName || ""), appName: String(m.appName || ""), versionName: String(m.versionName || ""), versionCode: Number(m.versionCode) || 0, testBuild: Boolean(m.testBuild), source: String(m.sourceUrl || m.sourceFileName || "").slice(0, 120) };
    if (env.LICENSES) { try { await env.LICENSES.put(key, JSON.stringify(info)); } catch {} }
  } catch { /* branch already gone: details unknown */ }
  return info;
}

/**
 * One page of builds: releases (newest first) with app details. On the last page it also
 * returns build branches that have no release (failed or unfinished builds).
 */
export async function listBuilds(env, gh, { page = 1 } = {}) {
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const p = Math.max(1, Math.min(50, Math.floor(Number(page) || 1)));
  const releases = await gh(env, `${repo}/releases?per_page=${PAGE}&page=${p}`);
  const builds = [];
  for (const r of releases || []) {
    const tag = String(r.tag_name || "");
    const id = tag.startsWith("build-") ? tag.slice(6) : "";
    const size = (r.assets || []).reduce((s, a) => s + (Number(a.size) || 0), 0);
    if (!isBuildId(id)) { builds.push({ id: "", tag, special: true, name: r.name || tag, createdAt: r.created_at, size, hasRelease: true }); continue; }
    builds.push({ id, tag, createdAt: r.created_at, size, hasRelease: true, ...(await buildInfo(env, gh, id)) });
  }
  const done = (releases || []).length < PAGE;
  let leftovers = [];
  if (done) {
    // Branches without a release: builds that failed or never ran.
    const names = [];
    for (let bp = 1; bp <= 5; bp++) {
      const branches = await gh(env, `${repo}/branches?per_page=100&page=${bp}`);
      for (const b of branches || []) if (/^build-/.test(b.name)) names.push(b.name.slice(6));
      if (!branches || branches.length < 100) break;
    }
    leftovers = names.filter(isBuildId);
  }
  return { page: p, done, builds, branchIds: leftovers };
}

/** Details for build branches that have no release (asked for in small batches by the page). */
export async function describeBranches(env, gh, ids) {
  const out = [];
  for (const id of (ids || []).filter(isBuildId).slice(0, 20)) out.push({ id, tag: "build-" + id, hasRelease: false, size: 0, ...(await buildInfo(env, gh, id)) });
  return out;
}

/** Deletes builds: release + tag, build branch, Actions artifact. Returns what was removed. */
export async function deleteBuilds(env, gh, ids) {
  const list = [...new Set((ids || []).map(String))];
  if (!list.length) throw err("Choose the builds to delete.", 400);
  if (list.length > DELETE_MAX) throw err(`Delete at most ${DELETE_MAX} builds per request.`, 400);
  if (!list.every(isBuildId)) throw err("Only instApped builds (build IDs) can be deleted here.", 400);
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const gone = (e) => /GitHub (404|422)/.test(String(e && e.message));
  const results = [];
  for (const id of list) {
    const r = { id, release: false, tag: false, branch: false, artifacts: 0, errors: [] };
    try {
      const rel = await gh(env, `${repo}/releases/tags/build-${id}`);
      await gh(env, `${repo}/releases/${rel.id}`, { method: "DELETE" });
      r.release = true;
    } catch (e) { if (!gone(e)) r.errors.push("release: " + e.message); }
    try { await gh(env, `${repo}/git/refs/tags/build-${id}`, { method: "DELETE" }); r.tag = true; }
    catch (e) { if (!gone(e)) r.errors.push("tag: " + e.message); }
    try { await gh(env, `${repo}/git/refs/heads/build-${id}`, { method: "DELETE" }); r.branch = true; }
    catch (e) { if (!gone(e)) r.errors.push("branch: " + e.message); }
    try {
      const a = await gh(env, `${repo}/actions/artifacts?name=${encodeURIComponent("app-" + id)}&per_page=10`);
      for (const art of a?.artifacts || []) {
        try { await gh(env, `${repo}/actions/artifacts/${art.id}`, { method: "DELETE" }); r.artifacts++; } catch (e) { if (!gone(e)) r.errors.push("artifact: " + e.message); }
      }
    } catch (e) { if (!gone(e)) r.errors.push("artifacts: " + e.message); }
    if (env.LICENSES) { try { await env.LICENSES.put("deleted:" + id, String(Date.now())); } catch {} }
    results.push(r);
  }
  return { results };
}
