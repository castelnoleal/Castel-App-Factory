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

// ------------------------------------------------------------ other releases

/** Deletes releases that aren't instApped builds (e.g. old test apps) by tag, with their tags. */
export async function deleteReleases(env, gh, tags) {
  const list = [...new Set((tags || []).map(String))].filter(Boolean);
  if (!list.length) throw err("Choose the releases to delete.", 400);
  if (list.length > 10) throw err("Delete at most 10 releases per request.", 400);
  if (!list.every((t) => /^[A-Za-z0-9._\-\/]{1,120}$/.test(t))) throw err("Invalid release tag.", 400);
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const gone = (e) => /GitHub (404|422)/.test(String(e && e.message));
  const results = [];
  for (const tag of list) {
    const r = { tag, release: false, tagRef: false, errors: [] };
    try { const rel = await gh(env, `${repo}/releases/tags/${encodeURIComponent(tag)}`); await gh(env, `${repo}/releases/${rel.id}`, { method: "DELETE" }); r.release = true; }
    catch (e) { if (!gone(e)) r.errors.push("release: " + e.message); }
    try { await gh(env, `${repo}/git/refs/tags/${tag}`, { method: "DELETE" }); r.tagRef = true; }
    catch (e) { if (!gone(e)) r.errors.push("tag: " + e.message); }
    results.push(r);
  }
  return { results };
}

// ------------------------------------------------------------- stored files

/** Stored workflow files (Actions artifacts) that haven't expired, newest first. */
export async function listArtifacts(env, gh) {
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const d = await gh(env, `${repo}/actions/artifacts?per_page=100&page=${page}`);
    const list = d?.artifacts || [];
    for (const a of list) if (!a.expired) out.push({ id: a.id, name: a.name, size: a.size_in_bytes || 0, createdAt: a.created_at, expiresAt: a.expires_at, branch: a.workflow_run?.head_branch || "" });
    if (list.length < 100) break;
  }
  return { artifacts: out, total: out.reduce((s, a) => s + a.size, 0) };
}

export async function deleteArtifacts(env, gh, ids) {
  const list = [...new Set((ids || []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw err("Choose the files to delete.", 400);
  if (list.length > 40) throw err("Delete at most 40 files per request.", 400);
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  let deleted = 0; const errors = [];
  for (const id of list) {
    try { await gh(env, `${repo}/actions/artifacts/${id}`, { method: "DELETE" }); deleted++; }
    catch (e) { if (/GitHub 404/.test(e.message)) deleted++; else errors.push(id + ": " + e.message); }
  }
  return { deleted, errors };
}

// ------------------------------------------------------------------ branches

/**
 * Branches other than the default branch, with whether their work is already in it:
 * "merged" (its pull request was merged), "in-main" (no commits that main lacks) or "unmerged".
 */
export async function listBranches(env, gh) {
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const info = await gh(env, repo);
  const main = info.default_branch || "main";
  const names = [];
  for (let page = 1; page <= 3; page++) {
    const list = await gh(env, `${repo}/branches?per_page=100&page=${page}`);
    for (const b of list || []) if (b.name !== main && !/^build-[0-9a-f]{8}-/.test(b.name)) names.push(b.name);
    if (!list || list.length < 100) break;
  }
  const prs = await gh(env, `${repo}/pulls?state=closed&per_page=100`).catch(() => []);
  const merged = new Map((prs || []).filter((p) => p.merged_at && p.head?.repo?.full_name === info.full_name).map((p) => [p.head.ref, p]));
  const branches = [];
  for (const name of names.slice(0, 40)) {
    const b = { name, status: "unmerged", ahead: 0, behind: 0, lastCommit: "", pr: 0 };
    const pr = merged.get(name);
    if (pr) { b.status = "merged"; b.pr = pr.number; }
    try {
      const c = await gh(env, `${repo}/compare/${encodeURIComponent(main)}...${encodeURIComponent(name)}`);
      b.ahead = c.ahead_by || 0; b.behind = c.behind_by || 0;
      const last = (c.commits || []).at(-1) || c.base_commit;
      b.lastCommit = last?.commit?.committer?.date || "";
      if (!pr && b.ahead === 0) b.status = "in-main";
    } catch {}
    branches.push(b);
  }
  return { main, branches };
}

export async function deleteBranches(env, gh, names) {
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const list = [...new Set((names || []).map(String))].filter(Boolean);
  if (!list.length) throw err("Choose the branches to delete.", 400);
  if (list.length > 20) throw err("Delete at most 20 branches per request.", 400);
  const info = await gh(env, repo);
  const main = info.default_branch || "main";
  if (list.some((n) => n === main || n === "main")) throw err("The main branch can't be deleted.", 400);
  if (!list.every((n) => /^[A-Za-z0-9._\-\/]{1,200}$/.test(n) && !n.includes(".."))) throw err("Invalid branch name.", 400);
  let deleted = 0; const errors = [];
  for (const n of list) {
    try { await gh(env, `${repo}/git/refs/heads/${n}`, { method: "DELETE" }); deleted++; }
    catch (e) { if (/GitHub (404|422)/.test(e.message)) deleted++; else errors.push(n + ": " + e.message); }
  }
  return { deleted, errors };
}

// ----------------------------------------------------------------- activity

/** Repository and GitHub Actions health, plus the most recent app builds. */
export async function activity(env, gh) {
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const info = await gh(env, repo);
  const runs = await gh(env, `${repo}/actions/workflows/build-app.yml/runs?per_page=12`).catch(() => ({ workflow_runs: [] }));
  const builds = [];
  let blocked = "";
  for (const r of runs?.workflow_runs || []) {
    const id = String(r.head_branch || "").replace(/^build-/, "");
    const b = { runId: r.id, url: r.html_url, status: r.status, conclusion: r.conclusion || "", createdAt: r.created_at, updatedAt: r.updated_at, id, appName: "", packageName: "", versionName: "", reason: "" };
    if (/^[0-9a-f-]{36}$/i.test(id)) Object.assign(b, await buildInfo(env, gh, id).then(({ appName, packageName, versionName }) => ({ appName, packageName, versionName })));
    builds.push(b);
  }
  // Explain the most recent failure (billing blocks show up as an annotation on the job).
  const lastFail = builds.find((b) => b.conclusion && b.conclusion !== "success");
  if (lastFail) {
    try {
      const jobs = await gh(env, `${repo}/actions/runs/${lastFail.runId}/jobs`);
      const job = jobs?.jobs?.[0];
      if (job) {
        const notes = await gh(env, `${repo}/check-runs/${job.id}/annotations`).catch(() => []);
        const text = (notes || []).map((n) => n.message || "").filter((m) => !/Node\.js \d+ is deprecated|ubuntu-latest label/.test(m)).join(" ");
        lastFail.reason = text.slice(0, 300);
        if (/payments have failed|spending limit|billing/i.test(text)) blocked = text.slice(0, 300);
      }
    } catch {}
  }
  const lastOk = builds.find((b) => b.conclusion === "success");
  if (blocked && lastOk && Date.parse(lastOk.createdAt) > Date.parse(lastFail.createdAt)) blocked = "";
  return {
    repo: { name: info.full_name, visibility: info.visibility || (info.private ? "private" : "public"), sizeKb: info.size, defaultBranch: info.default_branch, url: info.html_url },
    actions: { blocked: Boolean(blocked), message: blocked },
    builds,
  };
}
