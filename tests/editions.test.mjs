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
