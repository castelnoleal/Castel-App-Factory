// Unit tests for the build service (cloudflare-worker): plans, PayMongo
// checkout, license keys, webhooks and plan enforcement on /build.
// Run with: node --test tests/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../cloudflare-worker/worker.js";
import { issueLicense, verifyLicense, readSession, verifyWebhook, premiumFeaturesUsed, prices } from "../cloudflare-worker/billing.js";

const SECRET = "test-license-secret-0123456789";
const OWNER = "owner-token-abc";

function kv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } };
}

let env, calls, sessions, githubPuts;
beforeEach(() => {
  calls = [];
  githubPuts = [];
  sessions = new Map();
  env = {
    GITHUB_TOKEN: "gh", GITHUB_OWNER: "o", GITHUB_REPO: "r",
    CASTEL_SIGNING_ACCESS_TOKEN: OWNER,
    LICENSE_SECRET: SECRET,
    PAYMONGO_SECRET_KEY: "sk_test_123",
    PAYMONGO_WEBHOOK_SECRET: "whsk_test",
    LICENSES: kv(),
  };
  globalThis.fetch = async (url, opt = {}) => {
    url = String(url);
    calls.push({ url, opt });
    if (url.startsWith("https://api.paymongo.com/v1/checkout_sessions")) {
      assert.equal(opt.headers.Authorization, "Basic " + btoa("sk_test_123:"));
      if (opt.method === "POST") {
        const body = JSON.parse(opt.body);
        const id = "cs_test" + (sessions.size + 1);
        sessions.set(id, { data: { id, attributes: { ...body.data.attributes, payments: [], checkout_url: "https://checkout.paymongo.com/" + id } } });
        return new Response(JSON.stringify(sessions.get(id)), { status: 200 });
      }
      const id = url.split("/").pop();
      if (!sessions.has(id)) return new Response(JSON.stringify({ errors: [{ detail: "not found" }] }), { status: 404 });
      return new Response(JSON.stringify(sessions.get(id)), { status: 200 });
    }
    if (url.startsWith("https://api.github.com")) {
      if (url.includes("/git/ref/heads/main")) return new Response(JSON.stringify({ object: { sha: "abc" } }), { status: 200 });
      if (opt.method === "PUT") githubPuts.push({ path: url.split("/contents/")[1], body: JSON.parse(opt.body) });
      return new Response("{}", { status: 201 });
    }
    throw new Error("unexpected fetch " + url);
  };
});

const call = async (path, { method = "GET", body, headers = {} } = {}) => {
  const r = await worker.fetch(new Request("https://api.instapped.com" + path, { method, headers, body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
  return { status: r.status, json: await r.json() };
};
const markPaid = (id, paidAtSec = Math.floor(Date.now() / 1000)) => {
  sessions.get(id).data.attributes.payments = [{ id: "pay_1", attributes: { status: "paid", paid_at: paidAtSec } }];
};
const manifestOf = () => JSON.parse(Buffer.from(githubPuts.find((p) => p.path.endsWith("manifest.json")).body.content, "base64").toString());
const baseBuild = { appName: "Test App", packageName: "com.test.app", versionName: "1.0.0", versionCode: 1, sourceMode: "website", sourceUrl: "https://example.com" };

// ------------------------------------------------------------ license keys

test("license keys verify, carry the plan, and reject tampering and expiry", async () => {
  const exp = Date.now() + 86400000;
  const key = await issueLicense(SECRET, { plan: "pro", exp, ref: "cs_1" });
  assert.match(key, /^IAL1\.[\w-]+\.[\w-]+$/);
  const ok = await verifyLicense(SECRET, key);
  assert.equal(ok.valid, true);
  assert.equal(ok.plan, "pro");
  const [, body, sig] = key.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, plan: "business", exp, ref: "cs_1" })).toString("base64url");
  assert.equal((await verifyLicense(SECRET, `IAL1.${forged}.${sig}`)).valid, false, "changing the plan breaks the signature");
  assert.equal((await verifyLicense("other-secret", key)).valid, false, "a different secret rejects the key");
  const old = await issueLicense(SECRET, { plan: "pro", exp: Date.now() - 1000, ref: "x" });
  const expired = await verifyLicense(SECRET, old);
  assert.equal(expired.valid, false);
  assert.equal(expired.expired, true);
  assert.equal((await verifyLicense(SECRET, "garbage")).valid, false);
  assert.equal((await verifyLicense("", key)).valid, false);
  assert.ok(body.length > 10);
});

test("premium feature detection", () => {
  assert.deepEqual(premiumFeaturesUsed({}), []);
  assert.deepEqual(premiumFeaturesUsed({ themeColor: "#080b14", splashBackground: "#080B14" }), []);
  const ids = premiumFeaturesUsed({ signing: true, splashMode: "art", themeColor: "#FFFFFF", updateAlerts: true, pageNotifications: true }).map((f) => f.id);
  assert.deepEqual(ids, ["signing", "splashArt", "colours", "updateAlerts", "pageNotifications"]);
});

test("pricing overrides are validated", () => {
  assert.equal(prices({}).pro.monthly, 49900);
  assert.equal(prices({ PRICING_JSON: '{"pro":{"monthly":59900}}' }).pro.monthly, 59900);
  assert.equal(prices({ PRICING_JSON: '{"pro":{"monthly":5}}' }).pro.monthly, 49900, "absurdly low prices fall back");
  assert.equal(prices({ PRICING_JSON: "not json" }).business.annual, 1690000);
});

// -------------------------------------------------------- plans & checkout

test("GET /plans lists three plans in PHP and reports payment readiness", async () => {
  const { status, json } = await call("/plans");
  assert.equal(status, 200);
  assert.equal(json.currency, "PHP");
  assert.deepEqual(json.plans.map((p) => p.id), ["free", "pro", "business"]);
  assert.equal(json.paymentsEnabled, true);
  delete env.PAYMONGO_SECRET_KEY;
  assert.equal((await call("/plans")).json.paymentsEnabled, false);
});

test("POST /checkout creates a PayMongo session with trusted amount and redirect", async () => {
  const { status, json } = await call("/checkout", { method: "POST", body: { plan: "business", period: "annual", email: "a@b.co", amount: 1 } });
  assert.equal(status, 200);
  assert.match(json.sessionId, /^cs_/);
  assert.match(json.checkoutUrl, /^https:\/\/checkout\.paymongo\.com\//);
  assert.match(json.reference, /^IA-[0-9A-F]{12}$/);
  const sent = JSON.parse(calls.find((c) => c.opt.method === "POST").opt.body).data.attributes;
  assert.equal(sent.line_items[0].amount, 1690000, "amount comes from the server price list, not the client");
  assert.equal(sent.line_items[0].currency, "PHP");
  assert.deepEqual(sent.metadata, { product: "instapped", plan: "business", period: "annual" });
  assert.equal(sent.success_url, "https://create.instapped.com/#purchase=success", "redirect cannot be chosen by the caller");
  assert.deepEqual(sent.payment_method_types, ["card", "gcash", "paymaya"]);
  assert.equal(sent.billing.email, "a@b.co");
  assert.equal(await env.LICENSES.get("ref:" + json.reference), json.sessionId);
});

test("POST /checkout rejects unknown plans and works only when payments are configured", async () => {
  assert.equal((await call("/checkout", { method: "POST", body: { plan: "gold", period: "monthly" } })).status, 400);
  assert.equal((await call("/checkout", { method: "POST", body: { plan: "pro", period: "weekly" } })).status, 400);
  delete env.LICENSE_SECRET;
  assert.equal((await call("/checkout", { method: "POST", body: { plan: "pro", period: "monthly" } })).status, 503);
});

// ------------------------------------------------------------ claim & keys

test("claiming an unpaid checkout returns pending; a paid one issues a working key", async () => {
  const { json: co } = await call("/checkout", { method: "POST", body: { plan: "pro", period: "monthly" } });
  const pending = await call("/license/claim", { method: "POST", body: { sessionId: co.sessionId } });
  assert.equal(pending.status, 202, "still processing, not an error");
  assert.equal(pending.json.pending, true);
  markPaid(co.sessionId);
  const claimed = await call("/license/claim", { method: "POST", body: { sessionId: co.sessionId } });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.plan, "pro");
  const days = (claimed.json.exp - Date.now()) / 86400000;
  assert.ok(days > 33 && days < 35, "31 days + 3 days grace");
  const v = await call("/license/verify", { method: "POST", body: { key: claimed.json.key } });
  assert.equal(v.json.valid, true);
  assert.equal(v.json.plan, "pro");
  // Claiming again returns the same stored key.
  const again = await call("/license/claim", { method: "POST", body: { sessionId: co.sessionId } });
  assert.equal(again.json.key, claimed.json.key);
  // Recovery by the receipt reference.
  const rec = await call("/license/recover", { method: "POST", body: { reference: co.reference } });
  assert.equal(rec.json.key, claimed.json.key);
});

test("early renewal extends from the current expiry", async () => {
  const current = await issueLicense(SECRET, { plan: "pro", exp: Date.now() + 10 * 86400000, ref: "cs_old" });
  const { json: co } = await call("/checkout", { method: "POST", body: { plan: "pro", period: "monthly" } });
  markPaid(co.sessionId);
  const r = await call("/license/claim", { method: "POST", body: { sessionId: co.sessionId, currentKey: current } });
  const days = (r.json.exp - Date.now()) / 86400000;
  assert.ok(days > 43 && days < 45, "10 remaining + 31 + 3 grace");
});

test("claims reject foreign or malformed sessions", async () => {
  assert.equal((await call("/license/claim", { method: "POST", body: { sessionId: "../../x" } })).status, 400);
  sessions.set("cs_foreign", { data: { id: "cs_foreign", attributes: { metadata: { product: "other", plan: "pro", period: "monthly" }, payments: [{ attributes: { status: "paid", paid_at: 1 } }] } } });
  assert.equal((await call("/license/claim", { method: "POST", body: { sessionId: "cs_foreign" } })).status, 400);
  assert.equal((await call("/license/recover", { method: "POST", body: { reference: "IA-000000000000" } })).status, 404);
});

test("readSession accepts payment intent success as paid", () => {
  const s = readSession({ data: { attributes: { metadata: { plan: "pro", period: "annual", product: "instapped" }, payment_intent: { attributes: { status: "succeeded" } } } } });
  assert.equal(s.paid, true);
  assert.equal(s.paidAt, null);
});

// -------------------------------------------------------------- webhooks

test("webhooks require a valid PayMongo signature and store the key", async () => {
  const { json: co } = await call("/checkout", { method: "POST", body: { plan: "business", period: "monthly" } });
  markPaid(co.sessionId);
  const raw = JSON.stringify({ data: { attributes: { type: "checkout_session.payment.paid", data: { id: co.sessionId } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsk_test").update(`${t}.${raw}`).digest("hex");
  const bad = await call("/webhooks/paymongo", { method: "POST", body: raw, headers: { "Paymongo-Signature": `t=${t},te=deadbeef,li=` } });
  assert.equal(bad.status, 401);
  const good = await call("/webhooks/paymongo", { method: "POST", body: raw, headers: { "Paymongo-Signature": `t=${t},te=${sig},li=` } });
  assert.equal(good.status, 200);
  assert.ok(await env.LICENSES.get("session:" + co.sessionId), "key stored for recovery");
  assert.equal(await verifyWebhook("whsk_test", `t=${t - 3600},te=${sig},li=`, raw), false, "old timestamps are rejected");
});

// ------------------------------------------------------- build enforcement

test("free builds work, get the instApped badge, and premium options return 402", async () => {
  const ok = await call("/build", { method: "POST", body: baseBuild });
  assert.equal(ok.status, 202);
  assert.equal(ok.json.tier, "free");
  const m = manifestOf();
  assert.equal(m.brandBadge, true);
  assert.equal(m.tier, "free");
  for (const extra of [{ signing: true }, { splashMode: "art", splashBase64: "AAAA", splashFileName: "s.png" }, { themeColor: "#FFFFFF" }, { updateAlerts: true }, { pageNotifications: true }]) {
    const r = await call("/build", { method: "POST", body: { ...baseBuild, ...extra } });
    assert.equal(r.status, 402, JSON.stringify(extra));
    assert.equal(r.json.code, "upgrade_required");
    assert.ok(r.json.features.length === 1);
  }
});

test("a Pro license unlocks premium options and removes the badge; expired keys don't", async () => {
  const key = await issueLicense(SECRET, { plan: "pro", exp: Date.now() + 86400000, ref: "cs_p" });
  const r = await call("/build", { method: "POST", body: { ...baseBuild, licenseKey: key, signing: true, themeColor: "#FFFFFF", updateAlerts: true } });
  assert.equal(r.status, 202);
  assert.equal(r.json.tier, "pro");
  assert.equal(r.json.signing, true);
  const m = manifestOf();
  assert.equal(m.brandBadge, false);
  assert.equal(m.signing, true);
  assert.equal(m.themeColor, "#FFFFFF");
  const old = await issueLicense(SECRET, { plan: "pro", exp: Date.now() - 1, ref: "cs_old" });
  const denied = await call("/build", { method: "POST", body: { ...baseBuild, licenseKey: old, signing: true } });
  assert.equal(denied.status, 402);
  assert.match(denied.json.error, /expired/);
});

test("revoked licenses fall back to free", async () => {
  const key = await issueLicense(SECRET, { plan: "business", exp: Date.now() + 86400000, ref: "cs_rev" });
  await env.LICENSES.put("revoked:cs_rev", "1");
  const r = await call("/build", { method: "POST", body: { ...baseBuild, licenseKey: key, signing: true } });
  assert.equal(r.status, 402);
  assert.match(r.json.error, /revoked/);
});

test("the owner token counts as Business and is the only way to request test builds", async () => {
  const owner = await call("/build", { method: "POST", body: { ...baseBuild, signing: true, signingAccessToken: OWNER, testBuild: true } });
  assert.equal(owner.status, 202);
  assert.equal(owner.json.tier, "business");
  const stranger = await call("/build", { method: "POST", body: { ...baseBuild, testBuild: true } });
  assert.equal(stranger.status, 403);
  const v = await call("/license/verify", { method: "POST", body: { ownerToken: OWNER } });
  assert.equal(v.json.plan, "business");
});

test("free plan daily build limit", async () => {
  env.FREE_DAILY_BUILDS = "2";
  const headers = { "CF-Connecting-IP": "203.0.113.9", "Content-Type": "application/json" };
  assert.equal((await call("/build", { method: "POST", body: baseBuild, headers })).status, 202);
  assert.equal((await call("/build", { method: "POST", body: baseBuild, headers })).status, 202);
  const third = await call("/build", { method: "POST", body: baseBuild, headers });
  assert.equal(third.status, 429);
  assert.equal(third.json.code, "free_limit");
  const key = await issueLicense(SECRET, { plan: "pro", exp: Date.now() + 86400000, ref: "cs_q" });
  assert.equal((await call("/build", { method: "POST", body: { ...baseBuild, licenseKey: key }, headers })).status, 202, "paid plans aren't limited");
});

test("health reports the premium revision", async () => {
  const { json } = await call("/health");
  assert.equal(json.revision, "instapped-editions-v1");
});
