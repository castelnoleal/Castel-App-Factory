// instApped plans, PayMongo checkout and license keys.
//
// License keys are signed tokens (HMAC-SHA256 with LICENSE_SECRET), so the
// build service can verify them without a database:
//   IAL1.<base64url(JSON {v,plan,exp,ref})>.<base64url(signature)>
// Optional Cloudflare KV binding LICENSES stores issued keys for recovery,
// revocations, and free-tier daily build counts.

export const CURRENCY = "PHP";
export const TIERS = ["free", "pro", "business"];
export const PERIOD_DAYS = { monthly: 31, annual: 366 };
const GRACE_DAYS = 3;

// Prices are in centavos (PayMongo's smallest unit). Override with the
// PRICING_JSON variable, e.g. {"pro":{"monthly":49900,"annual":499000},...}.
export const DEFAULT_PRICES = {
  pro: { monthly: 49900, annual: 499000 },
  business: { monthly: 169000, annual: 1690000 },
};

export const PLAN_INFO = {
  free: {
    name: "Free",
    tagline: "Build and test Android apps from any web project.",
    features: [
      "HTML, ZIP and website apps",
      "Test APK builds",
      "Offline storage, links, permissions and more",
      "Small \"Made with instApped\" note on the splash screen",
    ],
  },
  pro: {
    name: "Pro",
    tagline: "Everything you need to publish on Google Play.",
    features: [
      "Signed, Play-ready AAB releases",
      "Splash art, app colour and no instApped badge",
      "Update alerts, update feed and page notifications",
      "No ads in the factory",
    ],
  },
  business: {
    name: "Business",
    tagline: "Publish apps for clients and your company.",
    features: [
      "Everything in Pro",
      "Publishing kit: store listing assets and text",
      "Privacy policy generator and Data safety answers",
      "Google Play submission checklist",
    ],
  },
};

export const tierRank = (tier) => Math.max(0, TIERS.indexOf(tier));

export function prices(env) {
  try {
    const custom = env && env.PRICING_JSON ? JSON.parse(env.PRICING_JSON) : null;
    if (custom && typeof custom === "object") {
      const out = {};
      for (const plan of ["pro", "business"]) {
        out[plan] = {};
        for (const period of ["monthly", "annual"]) {
          const v = Number(custom?.[plan]?.[period]);
          out[plan][period] = Number.isInteger(v) && v >= 2000 ? v : DEFAULT_PRICES[plan][period];
        }
      }
      return out;
    }
  } catch {}
  return DEFAULT_PRICES;
}

export function paymentsEnabled(env) {
  return Boolean(env && env.PAYMONGO_SECRET_KEY && env.LICENSE_SECRET);
}

export function plansPayload(env) {
  const p = prices(env);
  return {
    ok: true,
    currency: CURRENCY,
    paymentsEnabled: paymentsEnabled(env),
    plans: TIERS.map((id) => ({
      id,
      ...PLAN_INFO[id],
      prices: id === "free" ? { monthly: 0, annual: 0 } : p[id],
    })),
  };
}

// ------------------------------------------------------------------ crypto

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function hmacBytes(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a, b) {
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---------------------------------------------------------------- licenses

export async function issueLicense(secret, { plan, exp, ref }) {
  if (!secret) throw new Error("LICENSE_SECRET is not configured");
  if (!["pro", "business"].includes(plan)) throw new Error("Unknown plan");
  const body = b64url(enc.encode(JSON.stringify({ v: 1, plan, exp: Math.floor(exp), ref: String(ref || "") })));
  const sig = b64url(await hmacBytes(secret, "IAL1." + body));
  return `IAL1.${body}.${sig}`;
}

export async function verifyLicense(secret, key, now = Date.now()) {
  if (!secret) return { valid: false, reason: "Licensing isn't configured on this build service." };
  const parts = String(key || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== "IAL1") return { valid: false, reason: "That isn't an instApped license key." };
  const expected = b64url(await hmacBytes(secret, "IAL1." + parts[1]));
  if (!safeEqual(expected, parts[2])) return { valid: false, reason: "That license key isn't valid." };
  let payload;
  try { payload = JSON.parse(dec.decode(fromB64url(parts[1]))); } catch { return { valid: false, reason: "That license key is damaged." }; }
  if (!["pro", "business"].includes(payload.plan)) return { valid: false, reason: "Unknown plan in license key." };
  if (!(payload.exp > now)) return { valid: false, expired: true, plan: payload.plan, exp: payload.exp, ref: payload.ref, reason: "This license has expired. Renew it on the Plans page." };
  return { valid: true, plan: payload.plan, exp: payload.exp, ref: payload.ref };
}

/** Decide the caller's tier. The owner's signing token always counts as Business. */
export async function resolveTier(env, { licenseKey, ownerToken }) {
  if (ownerToken && env.CASTEL_SIGNING_ACCESS_TOKEN && safeEqual(ownerToken, env.CASTEL_SIGNING_ACCESS_TOKEN)) {
    return { tier: "business", owner: true };
  }
  if (licenseKey) {
    const v = await verifyLicense(env.LICENSE_SECRET, licenseKey);
    if (v.valid) {
      if (env.LICENSES && v.ref) {
        try { if (await env.LICENSES.get("revoked:" + v.ref)) return { tier: "free", licenseError: "This license was revoked. Contact support." }; } catch {}
      }
      return { tier: v.plan, exp: v.exp };
    }
    return { tier: "free", licenseError: v.reason };
  }
  return { tier: "free" };
}

/** Premium options a build request asks for, each with the lowest plan that includes it. */
export function premiumFeaturesUsed(o) {
  const used = [];
  const def = (c) => !c || String(c).toUpperCase() === "#080B14";
  if (o.signing) used.push({ id: "signing", label: "Signed Play-ready AAB", minTier: "pro" });
  if (o.splashMode === "art") used.push({ id: "splashArt", label: "Splash art", minTier: "pro" });
  if (!def(o.themeColor) || !def(o.splashBackground)) used.push({ id: "colours", label: "App and splash colours", minTier: "pro" });
  if (o.updateAlerts) used.push({ id: "updateAlerts", label: "Update alerts", minTier: "pro" });
  if (o.pageNotifications) used.push({ id: "pageNotifications", label: "Page notifications", minTier: "pro" });
  if (o.playBilling) used.push({ id: "playBilling", label: "Google Play Billing", minTier: "business" });
  return used;
}

// ---------------------------------------------------------------- PayMongo

const PAYMONGO = "https://api.paymongo.com/v1";

function paymongoHeaders(env) {
  return {
    Authorization: "Basic " + btoa(String(env.PAYMONGO_SECRET_KEY) + ":"),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function paymongo(env, path, options = {}) {
  const r = await fetch(PAYMONGO + path, { ...options, headers: { ...paymongoHeaders(env), ...(options.headers || {}) } });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const detail = data?.errors?.map((e) => e.detail).filter(Boolean).join(" ") || `HTTP ${r.status}`;
    const err = new Error("PayMongo: " + detail);
    err.status = r.status;
    throw err;
  }
  return data;
}

function randomRef() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return "IA-" + hex(b).toUpperCase();
}

export async function createCheckout(env, { plan, period, email, factoryUrl }) {
  if (!paymentsEnabled(env)) throw Object.assign(new Error("Payments aren't set up yet."), { status: 503 });
  if (!["pro", "business"].includes(plan)) throw Object.assign(new Error("Choose the Pro or Business plan."), { status: 400 });
  if (!["monthly", "annual"].includes(period)) throw Object.assign(new Error("Choose monthly or annual billing."), { status: 400 });
  const amount = prices(env)[plan][period];
  const base = String(factoryUrl || "https://create.instapped.com").replace(/\/+$/, "");
  const reference = randomRef();
  const methods = String(env.PAYMONGO_METHODS || "card,gcash,paymaya").split(",").map((s) => s.trim()).filter(Boolean);
  const name = `instApped ${PLAN_INFO[plan].name} (${period === "annual" ? "1 year" : "1 month"})`;
  const attributes = {
    line_items: [{ currency: CURRENCY, amount, name, quantity: 1 }],
    payment_method_types: methods,
    success_url: `${base}/#purchase=success`,
    cancel_url: `${base}/#plans`,
    description: `${name}. Your license key appears in the factory after payment.`,
    reference_number: reference,
    send_email_receipt: true,
    show_description: true,
    show_line_items: true,
    metadata: { product: "instapped", plan, period },
  };
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) attributes.billing = { email: String(email).slice(0, 200) };
  const data = await paymongo(env, "/checkout_sessions", { method: "POST", body: JSON.stringify({ data: { attributes } }) });
  const id = data?.data?.id;
  const checkoutUrl = data?.data?.attributes?.checkout_url;
  if (!id || !checkoutUrl) throw new Error("PayMongo didn't return a checkout link.");
  if (env.LICENSES) { try { await env.LICENSES.put("ref:" + reference, id, { expirationTtl: 60 * 60 * 24 * 400 }); } catch {} }
  return { sessionId: id, checkoutUrl, reference, amount, currency: CURRENCY };
}

/** Return {paid, plan, period, paidAt (ms), reference} for a checkout session. */
export function readSession(session) {
  const a = session?.data?.attributes || session?.attributes || {};
  const payments = Array.isArray(a.payments) ? a.payments : [];
  const paidPayments = payments.filter((p) => (p?.attributes?.status || p?.status) === "paid");
  const intentStatus = a.payment_intent?.attributes?.status || a.payment_intent?.status;
  const paid = paidPayments.length > 0 || intentStatus === "succeeded";
  const paidAtSec = Math.max(0, ...paidPayments.map((p) => Number(p?.attributes?.paid_at || p?.paid_at || 0)));
  const meta = a.metadata || {};
  return {
    paid,
    plan: meta.plan,
    period: meta.period,
    product: meta.product,
    paidAt: paidAtSec > 0 ? paidAtSec * 1000 : null,
    reference: a.reference_number || "",
  };
}

export async function claimCheckout(env, { sessionId, currentKey }) {
  if (!paymentsEnabled(env)) throw Object.assign(new Error("Payments aren't set up yet."), { status: 503 });
  if (!/^cs_[A-Za-z0-9]+$/.test(String(sessionId || ""))) throw Object.assign(new Error("That checkout reference isn't valid."), { status: 400 });
  if (env.LICENSES) {
    try { const saved = await env.LICENSES.get("session:" + sessionId); if (saved) return { ok: true, ...(await describe(env, saved)) }; } catch {}
  }
  const session = await paymongo(env, "/checkout_sessions/" + encodeURIComponent(sessionId));
  const s = readSession(session);
  if (s.product !== "instapped" || !["pro", "business"].includes(s.plan) || !PERIOD_DAYS[s.period]) {
    throw Object.assign(new Error("That payment isn't an instApped plan."), { status: 400 });
  }
  if (!s.paid) return { ok: false, pending: true, error: "Payment hasn't completed yet. If you just paid, wait a moment and try again." };
  let start = s.paidAt || Date.now();
  // Renewing early adds the new period to the remaining time on the same or a lower plan.
  if (currentKey) {
    const cur = await verifyLicense(env.LICENSE_SECRET, currentKey);
    if (cur.valid && tierRank(cur.plan) <= tierRank(s.plan) && cur.exp > start) start = cur.exp;
  }
  const exp = start + (PERIOD_DAYS[s.period] + GRACE_DAYS) * 86400000;
  const key = await issueLicense(env.LICENSE_SECRET, { plan: s.plan, exp, ref: sessionId });
  if (env.LICENSES) {
    try {
      await env.LICENSES.put("session:" + sessionId, key);
      if (s.reference) await env.LICENSES.put("ref:" + s.reference, sessionId);
    } catch {}
  }
  return { ok: true, key, plan: s.plan, exp, reference: s.reference };
}

async function describe(env, key) {
  const v = await verifyLicense(env.LICENSE_SECRET, key, 0);
  return { key, plan: v.plan, exp: v.exp };
}

/** Find a checkout session from the reference shown on the receipt (needs the LICENSES KV binding). */
export async function sessionForReference(env, reference) {
  const ref = String(reference || "").trim().toUpperCase();
  if (/^CS_/i.test(ref)) return String(reference).trim();
  if (!/^IA-[0-9A-F]{12}$/.test(ref) || !env.LICENSES) return null;
  try { return await env.LICENSES.get("ref:" + ref); } catch { return null; }
}

/**
 * Verify a PayMongo webhook. Header: Paymongo-Signature: t=<ts>,te=<test sig>,li=<live sig>,
 * signature = hex(HMAC-SHA256(webhook secret, `${t}.${rawBody}`)).
 */
export async function verifyWebhook(secret, header, rawBody, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map((kv) => kv.trim().split("=")).filter((p) => p.length === 2));
  const t = parts.t;
  if (!t || Math.abs(now / 1000 - Number(t)) > 60 * 10) return false;
  const expected = hex(await hmacBytes(secret, `${t}.${rawBody}`));
  return [parts.li, parts.te].some((sig) => sig && safeEqual(expected, sig));
}

// ---------------------------------------------------------- free-tier limit

export async function freeBuildAllowed(env, clientId) {
  if (!env.LICENSES) return { allowed: true };
  const limit = Math.max(1, Number(env.FREE_DAILY_BUILDS || 5));
  const day = new Date().toISOString().slice(0, 10);
  const k = `free:${day}:${clientId}`;
  try {
    const used = Number((await env.LICENSES.get(k)) || 0);
    if (used >= limit) return { allowed: false, limit };
    await env.LICENSES.put(k, String(used + 1), { expirationTtl: 60 * 60 * 30 });
    return { allowed: true, remaining: limit - used - 1, limit };
  } catch {
    return { allowed: true };
  }
}
