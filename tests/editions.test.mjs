// Unit tests for the owner-only master edition, owner tools, and Google Play
// Billing verification. Run with: node --test tests/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import worker from "../cloudflare-worker/worker.js";
import { resetMasterCache } from "../cloudflare-worker/owner.js";
import { resetPlayTokenCache } from "../cloudflare-worker/play.js";
import { verifyLicense } from "../cloudflare-worker/billing.js";

const OWNER = "owner-token-xyz";
const SECRET = "license-secret-for-tests";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = { client_email: "play@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
const FACTORY = "<!doctype html><html><head><meta charset=\"utf-8\">\n<meta name=\"theme-color\" content=\"#101a2e\">\n<title>instApped</title></head><body>FACTORY_BODY</body></html>";

let env, calls, subs;
function kv() { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; }
beforeEach(() => {
  resetMasterCache();
  resetPlayTokenCache();
  calls = [];
  subs = new Map();
  env = { GITHUB_TOKEN: "gh", GITHUB_OWNER: "o", GITHUB_REPO: "r", CASTEL_SIGNING_ACCESS_TOKEN: OWNER, LICENSE_SECRET: SECRET, LICENSES: kv(), GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify(SA) };
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url);
    calls.push({ url, opt });
    if (url.includes("/contents/factory/index.html")) return new Response(JSON.stringify({ content: Buffer.from(FACTORY).toString("base64") }), { status: 200 });
    if (url === "https://oauth2.googleapis.com/token") {
      const assertion = decodeURIComponent(String(opt.body)).split("assertion=")[1];
      const [h, c, sig] = assertion.split(".");
      const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      if (!ok || claims.iss !== SA.client_email || claims.scope !== "https://www.googleapis.com/auth/androidpublisher") return new Response('{"error":"invalid_grant"}', { status: 400 });
      return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://androidpublisher.googleapis.com/")) {
      assert.equal(opt.headers.Authorization, "Bearer ya29.test");
      if (url.endsWith(":acknowledge")) { calls.ack = (calls.ack || 0) + 1; return new Response("{}", { status: 200 }); }
      const token = decodeURIComponent(url.split("/tokens/")[1]);
      if (!subs.has(token)) return new Response(JSON.stringify({ error: { message: "The purchase token is no longer valid." } }), { status: 400 });
      return new Response(JSON.stringify(subs.get(token)), { status: 200 });
    }
    if (url.startsWith("https://api.github.com")) {
      if (url.includes("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "abc" } }), { status: 200 });
      return new Response("{}", { status: 201 });
    }
    throw new Error("unexpected fetch " + url);
  };
});

const req = (path, { method = "GET", body, headers = {}, form } = {}) => {
  const init = { method, headers: { ...headers } };
  if (form) { init.body = new URLSearchParams(form).toString(); init.headers["Content-Type"] = "application/x-www-form-urlencoded"; }
  else if (body != null) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(new Request("https://api.instapped.com" + path, init), env);
};
async function login() {
  const r = await req("/master/login", { method: "POST", form: { token: OWNER } });
  assert.equal(r.status, 303);
  const cookie = r.headers.get("Set-Cookie");
  assert.match(cookie, /^ia_owner=v1\.\d+\.[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  return cookie.split(";")[0];
}

// ------------------------------------------------------------- master

test("/master shows the sign-in page until the owner signs in", async () => {
  const r = await req("/master");
  assert.equal(r.status, 401);
  const html = await r.text();
  assert.match(html, /Owner access only/);
  assert.doesNotMatch(html, /FACTORY_BODY/);
  assert.equal(r.headers.get("X-Frame-Options"), "DENY");
  assert.match(r.headers.get("X-Robots-Tag"), /noindex/);
});

test("a wrong token is rejected; the right one opens the mirrored factory in master mode", async () => {
  const bad = await req("/master/login", { method: "POST", form: { token: "nope" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("Set-Cookie"), null);
  const cookie = await login();
  const page = await req("/master", { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /FACTORY_BODY/, "serves the factory from main");
  assert.match(html, /window\.INSTAPPED_EDITION=\{edition:"master"\}/);
  assert.match(html, /<title>instApped master<\/title>/);
  assert.match(html, /noindex,nofollow/);
  assert.ok(calls.some((c) => c.url.includes("/contents/factory/index.html?ref=main")), "fetched from the main branch");
});

test("forged or expired session cookies don't open /master", async () => {
  const cookie = await login();
  const [, exp, sig] = cookie.split("=")[1].split(".");
  const forged = `ia_owner=v1.${Number(exp) + 999999}.${sig}`;
  assert.equal((await req("/master", { headers: { Cookie: forged } })).status, 401);
  assert.equal((await req("/master", { headers: { Cookie: "ia_owner=v1.1.abc" } })).status, 401);
  env.LICENSE_SECRET = "rotated";
  assert.equal((await req("/master", { headers: { Cookie: cookie } })).status, 401, "rotating the secret signs everyone out");
});

test("sign-in attempts are rate limited", async () => {
  const headers = { "CF-Connecting-IP": "198.51.100.7" };
  for (let i = 0; i < 8; i++) await req("/master/login", { method: "POST", form: { token: "x" + i }, headers });
  const blocked = await req("/master/login", { method: "POST", form: { token: OWNER }, headers });
  assert.equal(blocked.status, 429);
});

test("the owner session builds as Business without a token in the page", async () => {
  const cookie = await login();
  const r = await req("/build", { method: "POST", headers: { Cookie: cookie }, body: { appName: "Mine", packageName: "com.me.app", versionName: "1.0.0", versionCode: 1, sourceMode: "website", sourceUrl: "https://example.com", signing: true, splashMode: "icon", themeColor: "#FFFFFF" } });
  assert.equal(r.status, 202);
  const j = await r.json();
  assert.equal(j.tier, "business");
  assert.equal(j.signing, true);
});

test("logout clears the session cookie", async () => {
  const r = await req("/master/logout", { method: "POST" });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("Set-Cookie"), /^ia_owner=; .*Max-Age=0/);
});

// --------------------------------------------------------- owner tools

test("owner tools require the owner and issue working complimentary licenses", async () => {
  assert.equal((await req("/admin/status")).status, 401);
  assert.equal((await req("/admin/license", { method: "POST", body: { plan: "pro", days: 30 } })).status, 401);
  const cookie = await login();
  const st = await (await req("/admin/status", { headers: { Cookie: cookie } })).json();
  assert.equal(st.config.licenseSecret, true);
  assert.equal(st.config.paymongo, false);
  assert.equal(st.config.googlePlay, true);
  const issued = await (await req("/admin/license", { method: "POST", headers: { Cookie: cookie }, body: { plan: "business", days: 90, note: "Client A" } })).json();
  assert.equal(issued.ok, true);
  const v = await verifyLicense(SECRET, issued.key);
  assert.equal(v.plan, "business");
  assert.match(v.ref, /^comp:[0-9a-f]{12}$/);
  assert.ok((v.exp - Date.now()) / 86400000 > 89);
  const bad = await req("/admin/license", { method: "POST", headers: { Cookie: cookie }, body: { plan: "pro", days: 0 } });
  assert.equal(bad.status, 400);
  // Revoke it, then it no longer unlocks builds.
  const rev = await req("/admin/revoke", { method: "POST", headers: { Cookie: cookie }, body: { ref: v.ref } });
  assert.equal(rev.status, 200);
  const blocked = await req("/build", { method: "POST", body: { appName: "Client", packageName: "com.c.app", versionName: "1.0.0", versionCode: 1, sourceMode: "website", sourceUrl: "https://example.com", licenseKey: issued.key, signing: true } });
  assert.equal(blocked.status, 402);
});

test("owner tools also accept the owner token directly", async () => {
  const r = await req("/admin/status", { headers: { "X-Castel-Signing-Access": OWNER } });
  assert.equal(r.status, 200);
});

// --------------------------------------------------------- Google Play

const playBody = (token, extra = {}) => ({ packageName: "com.instapped.app", productId: "instapped_pro", purchaseToken: token, ...extra });
const activeSub = (expiryDays = 30, overrides = {}) => ({
  subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  latestOrderId: "GPA.1234-5678-9012-34567",
  lineItems: [{ productId: "instapped_pro", expiryTime: new Date(Date.now() + expiryDays * 86400000).toISOString() }],
  ...overrides,
});

test("an active Play subscription is verified with Google, acknowledged, and issues a license", async () => {
  const token = "tok_" + "a".repeat(40);
  subs.set(token, activeSub(30));
  const r = await req("/license/play", { method: "POST", body: playBody(token) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.plan, "pro");
  const v = await verifyLicense(SECRET, j.key);
  assert.equal(v.valid, true);
  assert.equal(v.ref, "play:GPA.1234-5678-9012-34567");
  assert.equal(calls.ack, 1, "pending purchases are acknowledged so Google doesn't refund them");
});

test("Business product maps to the Business plan; acknowledged purchases aren't acknowledged again", async () => {
  const token = "tok_" + "b".repeat(40);
  subs.set(token, activeSub(365, { acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", lineItems: [{ productId: "instapped_business", expiryTime: new Date(Date.now() + 365 * 86400000).toISOString() }] }));
  const j = await (await req("/license/play", { method: "POST", body: playBody(token, { productId: "instapped_business" }) })).json();
  assert.equal(j.plan, "business");
  assert.equal(calls.ack, undefined);
});

test("expired, foreign, unknown or tampered Play purchases are refused", async () => {
  const expired = "tok_" + "c".repeat(40);
  subs.set(expired, activeSub(-1, { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }));
  const e = await req("/license/play", { method: "POST", body: playBody(expired) });
  assert.equal(e.status, 409);
  assert.equal((await e.json()).inactive, true);
  assert.equal((await req("/license/play", { method: "POST", body: playBody("tok_" + "d".repeat(40), { packageName: "com.evil.clone" }) })).status, 403);
  assert.equal((await req("/license/play", { method: "POST", body: playBody("tok_" + "e".repeat(40)) })).status, 400, "unknown token");
  const other = "tok_" + "f".repeat(40);
  subs.set(other, activeSub(30, { lineItems: [{ productId: "some_other_sub", expiryTime: new Date(Date.now() + 86400000).toISOString() }] }));
  assert.equal((await req("/license/play", { method: "POST", body: playBody(other) })).status, 400, "product that isn't an instApped plan");
  assert.equal((await req("/license/play", { method: "POST", body: playBody("bad token!") })).status, 400);
});

test("cancelled subscriptions keep access until they expire", async () => {
  const token = "tok_" + "g".repeat(40);
  subs.set(token, activeSub(10, { subscriptionState: "SUBSCRIPTION_STATE_CANCELED" }));
  assert.equal((await req("/license/play", { method: "POST", body: playBody(token) })).status, 200);
});

test("Play verification reports a clear error when Google Play isn't connected", async () => {
  delete env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const r = await req("/license/play", { method: "POST", body: playBody("tok_" + "h".repeat(40)) });
  assert.equal(r.status, 503);
});

test("Google Play Billing in a user's app needs Business; Pro keys get a clear 402", async () => {
  const { issueLicense } = await import("../cloudflare-worker/billing.js");
  const pro = await issueLicense(SECRET, { plan: "pro", exp: Date.now() + 86400000, ref: "t-pro" });
  const body = { appName: "Shop", packageName: "com.shop.app", versionName: "1.0.0", versionCode: 1, sourceMode: "website", sourceUrl: "https://example.com", playBilling: true };
  const r = await req("/build", { method: "POST", body: { ...body, licenseKey: pro } });
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.requiredPlan, "business");
  assert.match(j.error, /Google Play Billing needs instApped Business/);
  const biz = await issueLicense(SECRET, { plan: "business", exp: Date.now() + 86400000, ref: "t-biz" });
  assert.equal((await req("/build", { method: "POST", body: { ...body, licenseKey: biz } })).status, 202);
});

test("/license/verify reports revoked keys as invalid", async () => {
  const { issueLicense } = await import("../cloudflare-worker/billing.js");
  const key = await issueLicense(SECRET, { plan: "pro", exp: Date.now() + 86400000, ref: "IA-REVOKEME" });
  assert.equal((await (await req("/license/verify", { method: "POST", body: { key } })).json()).valid, true);
  await env.LICENSES.put("revoked:IA-REVOKEME", "1");
  const v = await (await req("/license/verify", { method: "POST", body: { key } })).json();
  assert.equal(v.valid, false);
  assert.equal(v.revoked, true);
});

// ------------------------------------------------- builds GitHub never ran

function stalledBuild(id, { run, jobs, annotations, ageMs = 5 * 60000 }) {
  const status = { buildId: id, status: "queued", updatedAt: new Date(Date.now() - ageMs).toISOString() };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    url = String(url);
    if (url.includes(`/contents/build-inputs/${id}/status.json`)) return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(status)).toString("base64") }), { status: 200 });
    if (url.includes(`/actions/runs?branch=build-${id}`)) return new Response(JSON.stringify({ workflow_runs: run ? [run] : [] }), { status: 200 });
    if (run && url.endsWith(`/actions/runs/${run.id}/jobs`)) return new Response(JSON.stringify({ jobs }), { status: 200 });
    if (url.includes("/check-runs/") && url.endsWith("/annotations")) return new Response(JSON.stringify(annotations || []), { status: 200 });
    return prev(url, opt);
  };
}

test("a build GitHub refused to start for billing reasons is reported as failed with the reason", async () => {
  const id = "846d760b-6b59-48bf-8fcb-837bd331e820";
  stalledBuild(id, {
    run: { id: 39901377592, name: "Build Generated App", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/39901377592" },
    jobs: [{ id: 120243509390, steps: [] }],
    annotations: [{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings" }],
  });
  const d = await (await req(`/build/${id}`)).json();
  assert.equal(d.status, "failed");
  assert.equal(d.code, "github_billing");
  assert.match(d.error, /billing problem on the GitHub account/);
  assert.match(d.runUrl, /39901377592/);
});

test("a build that failed on GitHub without updating its status is reported as failed", async () => {
  const id = "909dd599-f123-4aba-b3a0-ffc66b68dbd8";
  stalledBuild(id, { run: { id: 5, name: "Build Generated App", status: "completed", conclusion: "failure", html_url: "u" }, jobs: [{ id: 6, steps: [{ name: "Checkout" }] }], annotations: [{ message: "Process completed with exit code 1." }] });
  const d = await (await req(`/build/${id}`)).json();
  assert.equal(d.status, "failed");
  assert.match(d.error, /exit code 1/);
});

test("a queued build that's still running on GitHub, or only just queued, stays queued", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  stalledBuild(id, { run: { id: 7, name: "Build Generated App", status: "in_progress", conclusion: null } });
  assert.equal((await (await req(`/build/${id}`)).json()).status, "queued");
  stalledBuild(id, { run: null, ageMs: 2 * 60000 });
  assert.equal((await (await req(`/build/${id}`)).json()).status, "queued");
  stalledBuild(id, { run: null, ageMs: 15 * 60000 });
  const d = await (await req(`/build/${id}`)).json();
  assert.equal(d.status, "failed");
  assert.equal(d.code, "not_started");
});

// ------------------------------------------------------- builds cleanup

function fakeGitHub() {
  const ids = ["aaaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000002", "aaaaaaaa-0000-0000-0000-000000000003"];
  const gh = {
    releases: [
      { id: 11, tag_name: "build-" + ids[0], created_at: "2026-10-22T10:00:00Z", assets: [{ size: 3000000 }, { size: 3500000 }] },
      { id: 12, tag_name: "build-" + ids[1], created_at: "2026-10-12T10:00:00Z", assets: [{ size: 4900000 }] },
      { id: 13, tag_name: "test-latest", created_at: "2026-08-28T10:00:00Z", assets: [{ size: 4000000 }] },
    ],
    branches: ["main", "build-" + ids[0], "build-" + ids[1], "build-" + ids[2]],
    manifests: { [ids[0]]: { packageName: "com.duelsynapse.kodex", appName: "Meiocg KodeX", versionName: "1.0.3", versionCode: 3 }, [ids[1]]: { packageName: "com.duelsynapse.kodex", appName: "Meiocg KodeX", versionName: "1.1.0", versionCode: 2 }, [ids[2]]: { packageName: "com.duelsynapse.kodex", appName: "Meiocg KodeX", versionName: "1.0.3", versionCode: 3 } },
    deleted: [], ids,
  };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url);
    const json = (d, s = 200) => new Response(d == null ? "" : JSON.stringify(d), { status: s });
    if (!url.startsWith("https://api.github.com")) return prev(url, opt);
    const path = url.replace("https://api.github.com/repos/o/r", "");
    if (opt.method === "DELETE") { gh.deleted.push(path); return new Response(null, { status: 204 }); }
    if (path.startsWith("/releases?")) { const page = Number(new URL(url).searchParams.get("page")); return json(page === 1 ? gh.releases : []); }
    if (path.startsWith("/releases/tags/")) { const r = gh.releases.find(x => x.tag_name === path.split("/").pop()); return r ? json(r) : json({ message: "Not Found" }, 404); }
    if (path.startsWith("/branches?")) return json(gh.branches.map(name => ({ name })));
    const m = path.match(/^\/contents\/build-inputs\/([0-9a-f-]+)\/manifest\.json/);
    if (m) return gh.manifests[m[1]] ? json({ content: Buffer.from(JSON.stringify(gh.manifests[m[1]])).toString("base64") }) : json({ message: "Not Found" }, 404);
    if (path.startsWith("/actions/artifacts?")) return json({ artifacts: [{ id: 99 }] });
    return json({ message: "Not Found" }, 404);
  };
  return gh;
}

test("owner can list builds with app details, including failed builds that have no release", async () => {
  const gh = fakeGitHub();
  assert.equal((await req("/admin/builds")).status, 401, "owner only");
  const cookie = await login();
  const d = await (await req("/admin/builds?page=1", { headers: { Cookie: cookie } })).json();
  assert.equal(d.done, true);
  assert.equal(d.builds.length, 3);
  assert.equal(d.builds[0].packageName, "com.duelsynapse.kodex");
  assert.equal(d.builds[0].versionName, "1.0.3");
  assert.equal(d.builds[0].size, 6500000);
  assert.equal(d.builds[2].special, true, "test-latest isn't a deletable build");
  assert.deepEqual(d.branchIds, gh.ids);
  const orphans = await (await req("/admin/builds/describe", { method: "POST", headers: { Cookie: cookie }, body: { ids: [gh.ids[2]] } })).json();
  assert.equal(orphans.builds[0].hasRelease, false);
  assert.equal(orphans.builds[0].appName, "Meiocg KodeX");
});

test("deleting a build removes its release, tag, branch and artifact, and nothing else", async () => {
  const gh = fakeGitHub();
  const cookie = await login();
  const d = await (await req("/admin/builds/delete", { method: "POST", headers: { Cookie: cookie }, body: { ids: [gh.ids[1]] } })).json();
  assert.equal(d.ok, true);
  assert.deepEqual(d.results[0], { id: gh.ids[1], release: true, tag: true, branch: true, artifacts: 1, errors: [] });
  assert.deepEqual(gh.deleted.sort(), ["/actions/artifacts/99", "/git/refs/heads/build-" + gh.ids[1], "/git/refs/tags/build-" + gh.ids[1], "/releases/12"].sort());
  // A build with no release (failed) still has its branch removed.
  gh.deleted.length = 0;
  const f = await (await req("/admin/builds/delete", { method: "POST", headers: { Cookie: cookie }, body: { ids: [gh.ids[2]] } })).json();
  assert.equal(f.results[0].branch, true);
  assert.equal(f.results[0].release, false);
  assert.deepEqual(f.results[0].errors, []);
});

test("build deletion refuses non-builds, too many at once, and non-owners", async () => {
  fakeGitHub();
  const cookie = await login();
  for (const ids of [[], ["main"], ["test-latest"], Array.from({ length: 7 }, (_, i) => `aaaaaaaa-0000-0000-0000-00000000001${i}`)]) {
    assert.equal((await req("/admin/builds/delete", { method: "POST", headers: { Cookie: cookie }, body: { ids } })).status, 400, JSON.stringify(ids));
  }
  assert.equal((await req("/admin/builds/delete", { method: "POST", body: { ids: ["aaaaaaaa-0000-0000-0000-000000000001"] } })).status, 401);
});

// ------------------------------------- test apps, stored files, branches, activity, licenses

function fakeRepo() {
  const st = { deleted: [] };
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url);
    const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
    if (!url.startsWith("https://api.github.com")) return prev(url, opt);
    const path = url.replace("https://api.github.com/repos/o/r", "");
    if (opt.method === "DELETE") { st.deleted.push(path); return new Response(null, { status: 204 }); }
    if (path === "") return json({ full_name: "o/r", default_branch: "main", visibility: "public", size: 6000, html_url: "https://github.com/o/r" });
    if (path.startsWith("/releases/tags/")) return json({ id: 77 });
    if (path.startsWith("/actions/artifacts?")) return json({ artifacts: [{ id: 1, name: "castel-template-verification", size_in_bytes: 5e6, expired: false, created_at: "2026-10-20T00:00:00Z", expires_at: "2027-01-18T00:00:00Z", workflow_run: { head_branch: "main" } }, { id: 2, name: "old", size_in_bytes: 1, expired: true }] });
    if (path.startsWith("/branches?")) return json([{ name: "main" }, { name: "editions" }, { name: "synapse-android" }, { name: "build-aaaaaaaa-0000-0000-0000-000000000001" }]);
    if (path.startsWith("/pulls?")) return json([{ number: 9, merged_at: "2026-10-22T00:00:00Z", head: { ref: "editions", repo: { full_name: "o/r" } } }, { number: 3, merged_at: null, head: { ref: "synapse-android", repo: { full_name: "o/r" } } }]);
    if (path.startsWith("/compare/main...editions")) return json({ ahead_by: 2, behind_by: 5, commits: [{ commit: { committer: { date: "2026-10-22T00:00:00Z" } } }] });
    if (path.startsWith("/compare/main...synapse-android")) return json({ ahead_by: 14, behind_by: 90, commits: [{ commit: { committer: { date: "2026-09-01T00:00:00Z" } } }] });
    if (path.startsWith("/actions/workflows/build-app.yml/runs")) return json({ workflow_runs: [{ id: 5, html_url: "u5", status: "completed", conclusion: "failure", created_at: "2026-10-23T04:38:18Z", head_branch: "build-aaaaaaaa-0000-0000-0000-000000000009" }] });
    if (path === "/actions/runs/5/jobs") return json({ jobs: [{ id: 50, steps: [] }] });
    if (path === "/check-runs/50/annotations") return json([{ message: "The job was not started because recent account payments have failed or your spending limit needs to be increased." }]);
    return json({ message: "Not Found" }, 404);
  };
  return st;
}

test("owner can delete test apps, stored files and branches, but never main", async () => {
  const st = fakeRepo();
  const cookie = await login();
  const rel = await (await req("/admin/releases/delete", { method: "POST", headers: { Cookie: cookie }, body: { tags: ["cards-test-latest"] } })).json();
  assert.equal(rel.results[0].release, true);
  assert.ok(st.deleted.includes("/releases/77") && st.deleted.includes("/git/refs/tags/cards-test-latest"));
  const files = await (await req("/admin/artifacts", { headers: { Cookie: cookie } })).json();
  assert.equal(files.artifacts.length, 1, "expired files are left out");
  assert.equal((await (await req("/admin/artifacts/delete", { method: "POST", headers: { Cookie: cookie }, body: { ids: [1] } })).json()).deleted, 1);
  const br = await (await req("/admin/branches", { headers: { Cookie: cookie } })).json();
  assert.deepEqual(br.branches.map(b => [b.name, b.status]), [["editions", "merged"], ["synapse-android", "unmerged"]], "main and build branches aren't listed");
  assert.equal(br.branches[1].ahead, 14);
  assert.equal((await req("/admin/branches/delete", { method: "POST", headers: { Cookie: cookie }, body: { names: ["main"] } })).status, 400);
  assert.equal((await req("/admin/branches/delete", { method: "POST", headers: { Cookie: cookie }, body: { names: ["../x"] } })).status, 400);
  assert.equal((await (await req("/admin/branches/delete", { method: "POST", headers: { Cookie: cookie }, body: { names: ["editions"] } })).json()).deleted, 1);
  assert.ok(st.deleted.includes("/git/refs/heads/editions"));
  for (const p of ["/admin/artifacts", "/admin/branches", "/admin/activity", "/admin/licenses"]) assert.equal((await req(p)).status, 401, p + " is owner only");
});

test("activity shows repository visibility and flags GitHub refusing builds", async () => {
  fakeRepo();
  const cookie = await login();
  const a = await (await req("/admin/activity", { headers: { Cookie: cookie } })).json();
  assert.equal(a.repo.visibility, "public");
  assert.equal(a.actions.blocked, true);
  assert.match(a.builds[0].reason, /spending limit/);
});

test("licenses list sales, Play subscriptions and complimentary keys, and marks revoked ones", async () => {
  fakeRepo();
  env.LICENSES.list = async ({ prefix }) => ({ keys: [...env.LICENSES.m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) });
  const cookie = await login();
  const comp = await (await req("/admin/license", { method: "POST", headers: { Cookie: cookie }, body: { plan: "pro", days: 10, note: "Client A" } })).json();
  await req("/admin/revoke", { method: "POST", headers: { Cookie: cookie }, body: { ref: comp.ref } });
  const l = await (await req("/admin/licenses", { headers: { Cookie: cookie } })).json();
  assert.equal(l.available, true);
  assert.equal(l.complimentary[0].note, "Client A");
  assert.equal(l.complimentary[0].revoked, true);
  assert.equal(l.revoked[0].ref, comp.ref);
});
